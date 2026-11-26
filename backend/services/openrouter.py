import asyncio
import base64
import io
import json
import logging

from PIL import Image, ImageOps

from config import (
    ANTHROPIC_KEY,
    CLAUDE_MODELS,
    EXTRACTION_MODEL,
    FALLBACK_MODEL,
    OPENROUTER_SITE_TITLE,
    OPENROUTER_SITE_URL,
)
from services.client import get_anthropic_client, get_async_client

log = logging.getLogger(__name__)

_CLAUDE_MAX_TOKENS = 16000
# Claude refuses an image over 10 MiB once it's base64, which is a file of about 7.8 MB,
# and /extract accepts up to 10 MB. Claude shrinks anything bigger than this side itself.
_CLAUDE_MAX_FILE_BYTES = 7_800_000
_CLAUDE_MAX_SIDE = 2576

EXTRACTION_TOOL = {
    "type": "function",
    "function": {
        "name": "extract_invoice_data",
        "description": "Extract header fields and every product line from a pharmacy delivery note / invoice image.",
        "parameters": {
            "type": "object",
            "properties": {
                "dc_number": {
                    "type": "string",
                    "description": "DC / invoice / bill number from the invoice header (e.g. 'INV-1234', 'DC00456'). Empty string if not found.",
                },
                "dc_date": {
                    "type": "string",
                    "description": "Invoice date in YYYY-MM-DD format. Empty string if not found.",
                },
                "supplier_name": {
                    "type": "string",
                    "description": "Supplier / distributor / seller name from the invoice header. Empty string if not found.",
                },
                "total_items": {
                    "type": "number",
                    "description": "The printed total number of items / lines (e.g. 'TOTAL ITEMS: 6'). 0 if not printed.",
                },
                "total_qty": {
                    "type": "number",
                    "description": "The printed total quantity (e.g. 'TOTAL QTY: 14'). 0 if not printed.",
                },
                "products": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "product_name": {
                                "type": "string",
                                "description": (
                                    "The medicine / drug name only. "
                                    "Some invoices have MFR (manufacturer code) and HSN columns that appear "
                                    "BEFORE the product name column — do NOT include those codes in this field. "
                                    "Do NOT include X+Y free-qty notation or pack size either."
                                ),
                            },
                            "batch_number": {
                                "type": "string",
                                "description": "Batch / lot number exactly as printed.",
                            },
                            "expiry": {
                                "type": "string",
                                "description": "Expiry date exactly as printed, e.g. '06-26' or '06/26'.",
                            },
                            "old_mrp":      {"type": "number"},
                            "mrp":          {"type": "number"},
                            "rate":         {"type": "number"},
                            "quantity": {
                                "type": "number",
                                "description": (
                                    "Paid quantity only. "
                                    "If an X+Y notation (e.g. '5+1') appears between the product name and pack column, "
                                    "use X (the FIRST number). Do NOT use the Qty column total when X+Y is present."
                                ),
                            },
                            "free": {
                                "type": "number",
                                "description": (
                                    "Free quantity. "
                                    "If an X+Y notation (e.g. '5+1') appears between the product name and pack column, "
                                    "use Y (the SECOND number). 0 if no X+Y notation and no dedicated Free column."
                                ),
                            },
                            "disc_percent": {"type": "number"},
                            "value": {
                                "type": "number",
                                "description": "The row's printed Value / Amount column, exactly as printed. 0 if there is no such column.",
                            },
                        },
                        "required": ["product_name", "batch_number", "expiry", "old_mrp", "mrp", "rate", "quantity", "free", "disc_percent"],
                    },
                },
            },
            "required": ["dc_number", "dc_date", "supplier_name", "products"],
        },
    },
}

PROMPT = """\
<role>
You are an expert pharmaceutical invoice OCR parser. Your job is to read delivery \
note / invoice images and extract data with exact fidelity. \
Call the extract_invoice_data tool with your findings. \
Return nothing outside the tool call.
</role>

<critical_rules>
1. Extract only what you can clearly read in the image. If a field is blank, \
illegible, or absent — use "" for strings and 0 for numbers. Never guess or infer.
2. Ignore all handwritten ink, pen marks, stamps, signatures, and circled \
annotations. Extract printed/typed content only.
3. Preserve product names and batch numbers character-for-character as printed.
4. All numeric fields must be JSON numbers, not strings.
</critical_rules>

<free_qty_rule>
CRITICAL — apply this check to every product row before writing quantity or free.

Some rows have a notation such as "5+1", "9+1", "10+2" printed between the \
product name and the pack-size column. This means X units purchased + Y units free.

Per-row decision process:
  Step 1 — Look at the space between the product name and the pack column.
  Step 2 — Is there a pattern like "<number> + <number>"? (e.g. "5+1")
  Step 3a — YES → quantity = first number (X), free = second number (Y).
             The figure in the Qty column is the combined total (X+Y). Ignore it.
  Step 3b — NO  → quantity = the Qty column value, free = 0.
             (Use a dedicated Free column value if one exists.)

Do NOT include the X+Y text in product_name under any circumstances.
</free_qty_rule>

<examples>
Example 1 — row has MFR column, HSN column, AND a "5+1" free-qty notation:
  Raw row: EYS | 30045090 | HOLTO TAB | 5+1 | 10S | 229THL002 | ...  Qty col = 6
  product_name → "HOLTO TAB"   (EYS and 30045090 stripped; "5+1" NOT in name)
  quantity     → 5             (first number of "5+1" — NOT the Qty col total of 6)
  free         → 1             (second number of "5+1")

Example 2 — row has MFR column, HSN column, AND a "9+1" free-qty notation:
  Raw row: MAN | 34011110 | SCABELICE MEDICATED SOAP | 9+1 | 75GM | ...  Qty col = 10
  product_name → "SCABELICE MEDICATED SOAP"
  quantity     → 9
  free         → 1

Example 3 — row has MFR/HSN columns but NO free-qty notation:
  Raw row: HEC | 30049099 | MYMI GOLD CAP'S | 10S | RX001A8B | ...  Qty col = 3
  product_name → "MYMI GOLD CAP'S"
  quantity     → 3
  free         → 0

Example 4 — plain invoice with NO MFR/HSN columns and NO notation:
  product_name → "PARACETAMOL 500MG TAB"
  quantity     → 15
  free         → 0
</examples>

<header_fields>
Extract from the invoice header:
- dc_number    : DC / invoice / bill number (e.g. "DC-00456"). "" if not found.
- dc_date      : invoice date formatted as YYYY-MM-DD. "" if not found.
- supplier_name: supplier / distributor / seller name. "" if not found.
- total_items  : the printed total number of items / lines, if printed. 0 if not.
- total_qty    : the printed total quantity, if printed. 0 if not.
</header_fields>

<product_fields>
For every row in the product table extract:
- product_name  : the drug / medicine name only.
                  Some invoices have MFR (3-letter manufacturer code) and HSN
                  (numeric harmonized code) columns printed BEFORE the product
                  name column — do NOT include those in product_name.
                  Do NOT include X+Y notation or pack size either.
- batch_number  : batch / lot number exactly as printed
- expiry        : expiry date exactly as printed (e.g. "06-26", "06/26")
- old_mrp       : Old MRP column value; 0 if absent
- mrp           : MRP column value; 0 if absent
- rate          : Rate / Price column value; 0 if absent
- quantity      : paid units only — apply <free_qty_rule>
- free          : free units only — apply <free_qty_rule>
- disc_percent  : Discount % column value; 0 if absent.
                  The column header may be printed as "Disc", "Disc%", "Dis",
                  "Dis%", "Discount", "Discnt", or similar — treat all of these
                  as the same field.
                  Do NOT confuse this with GST%, CGST%, SGST%, IGST%, or any
                  Tax% column — those are a different field. Ignore them
                  entirely for this purpose, even if printed right next to the
                  discount column.
- value         : the row's Value / Amount column exactly as printed; 0 if absent.
                  Copy it, never calculate it.
</product_fields>"""


def _reasoning_body(model: str) -> dict:
    """Return the correct OpenRouter reasoning param for the given model family.

    - Nex                          → enabled: true (model-specific format)
    - Anthropic Claude             → max_tokens (minimum 1024 per OpenRouter docs)
    - Everything else (Gemini,     → effort string — OpenRouter maps this directly
      OpenAI o-series, Grok, etc.)   to Google's thinkingLevel for Gemini models
    """
    m = model.lower()
    if "nex-agi" in m:
        return {"reasoning": {"enabled": True}}
    if "anthropic" in m or "claude" in m:
        return {"reasoning": {"max_tokens": 8000}}
    return {"reasoning": {"effort": "high"}}


def _read_reply(response) -> dict:
    message = response.choices[0].message

    if not message.tool_calls:
        raise ValueError("Model returned no tool call. Could not extract data from the image.")

    tool_call = message.tool_calls[0]

    if tool_call.function.name != "extract_invoice_data":
        raise ValueError(f"Unexpected tool called: {tool_call.function.name}")

    parsed = json.loads(tool_call.function.arguments)

    if not isinstance(parsed.get("products"), list):
        return {"products": []}

    log.info("Extracted %d product(s) from image", len(parsed["products"]))
    return parsed


def _fits(value: object, kind: str) -> bool:
    if kind == "string":
        return isinstance(value, str)
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _usable(parsed: dict) -> bool:
    """Anthropic's OpenAI-compatible address doesn't enforce the tool's schema, so a
    missing field or one of the wrong type has to count as a failed read here: further
    on it would crash the request or the page, and the fallback can't help after that."""
    schema = EXTRACTION_TOOL["function"]["parameters"]
    header_fields = [f for f in schema["required"] if f != "products"]
    row_schema = schema["properties"]["products"]["items"]
    rows = parsed.get("products")
    return (
        bool(rows)
        and all(isinstance(parsed.get(f), str) for f in header_fields)
        and all(
            isinstance(r, dict) and all(_fits(r.get(f), row_schema["properties"][f]["type"]) for f in row_schema["required"])
            for r in rows
        )
    )


def _fit_for_claude(image_bytes: bytes, mime: str) -> tuple[bytes, str]:
    """Only a file too big for Claude is touched. The rotation tag is lost on saving,
    so it's applied first."""
    if len(image_bytes) <= _CLAUDE_MAX_FILE_BYTES:
        return image_bytes, mime
    with Image.open(io.BytesIO(image_bytes)) as original:
        img = ImageOps.exif_transpose(original).convert("RGB")
    img.thumbnail((_CLAUDE_MAX_SIDE, _CLAUDE_MAX_SIDE))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=90)
    return out.getvalue(), "image/jpeg"


def _build_content(prompt_text: str, pages: list[tuple[bytes, str]], product_image: tuple[bytes, str] | None) -> list[dict]:
    content: list[dict] = [{"type": "text", "text": prompt_text}]
    for image_bytes, mime_type in pages:
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        data_url = f"data:{mime_type};base64,{b64}"
        content.append({"type": "image_url", "image_url": {"url": data_url}})

    if product_image:
        p_bytes, p_mime = product_image
        p_b64 = base64.b64encode(p_bytes).decode("utf-8")
        p_data_url = f"data:{p_mime};base64,{p_b64}"
        content.append({
            "type": "text",
            "text": (
                "The image below is a supplementary photo of the product packaging from this delivery. "
                "Use it ONLY to clarify a product name that is unclear or ambiguous in the invoice above. "
                "The invoice remains the primary source of truth for all fields."
            ),
        })
        content.append({"type": "image_url", "image_url": {"url": p_data_url}})
    return content


async def _read_with_claude(content: list[dict], model: str) -> dict:
    if not ANTHROPIC_KEY:
        raise ValueError("ANTHROPIC_KEY is not set")

    # Forcing the tool is refused on these models, and thinking is always on, so
    # the prompt asks for the tool call and the reasoning setting doesn't apply.
    response = await get_anthropic_client().chat.completions.create(
        model=model,
        max_tokens=_CLAUDE_MAX_TOKENS,
        messages=[{"role": "user", "content": content}],
        tools=[EXTRACTION_TOOL],
        tool_choice="auto",
    )

    parsed = _read_reply(response)
    if not _usable(parsed):
        raise ValueError("Claude's reply had no usable table")
    return parsed


async def _read_with_openrouter(content: list[dict], model: str, reasoning: bool) -> dict:
    response = await get_async_client().chat.completions.create(
        extra_headers={
            "HTTP-Referer": OPENROUTER_SITE_URL,
            "X-OpenRouter-Title": OPENROUTER_SITE_TITLE,
        },
        extra_body=_reasoning_body(model) if reasoning else {},
        model=model,
        messages=[{"role": "user", "content": content}],
        tools=[EXTRACTION_TOOL],
        tool_choice={"type": "function", "function": {"name": "extract_invoice_data"}},
    )
    return _read_reply(response)


async def extract_invoice_data(
    images: list[tuple[bytes, str]],
    model: str | None = None,
    reasoning: bool = False,
    product_image_bytes: bytes | None = None,
    product_image_mime: str | None = None,
) -> dict:
    chosen_model = model or EXTRACTION_MODEL
    log.info(
        "Sending %d invoice page(s) to %s for extraction (reasoning=%s, product_image=%s)",
        len(images), chosen_model, reasoning, product_image_bytes is not None,
    )

    prompt_text = PROMPT
    if len(images) > 1:
        prompt_text += (
            "\n\n<multi_page_invoice>\n"
            "The following images are consecutive pages of the SAME delivery note / invoice, "
            "in page order. Treat them as one continuous document — extract header fields once "
            "(they typically only appear on the first page) and combine every product row from "
            "every page into a single products array.\n"
            "</multi_page_invoice>"
        )
    if product_image_bytes and product_image_mime:
        prompt_text += (
            "\n\n<product_image>\n"
            "A supplementary photo of the product packaging follows the invoice image below. "
            "Use it only to resolve product names that are unclear or ambiguous in the invoice — "
            "it is not a source of truth for any other fields (batch, expiry, MRP, rate, quantity, etc.).\n"
            "</product_image>"
        )

    product_image = (product_image_bytes, product_image_mime) if product_image_bytes and product_image_mime else None

    if chosen_model not in CLAUDE_MODELS:
        return await _read_with_openrouter(_build_content(prompt_text, images, product_image), chosen_model, reasoning)

    try:
        pages = [await asyncio.to_thread(_fit_for_claude, *page) for page in images]
        product = await asyncio.to_thread(_fit_for_claude, *product_image) if product_image else None
        return await _read_with_claude(_build_content(prompt_text, pages, product), chosen_model)
    except Exception as e:
        # Staff aren't told, so this log line is the only record. Type only: an
        # error's text can quote the request.
        log.warning("Claude couldn't read this DC (%s), using %s instead", type(e).__name__, FALLBACK_MODEL)
        return await _read_with_openrouter(_build_content(prompt_text, images, product_image), FALLBACK_MODEL, reasoning=True)
