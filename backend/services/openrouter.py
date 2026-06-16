import base64
import json
import logging

from config import EXTRACTION_MODEL, OPENROUTER_SITE_TITLE, OPENROUTER_SITE_URL
from services.client import get_async_client

log = logging.getLogger(__name__)

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
- disc_percent  : Disc% column value; 0 if absent
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


async def extract_invoice_data(image_bytes: bytes, mime_type: str, model: str | None = None, reasoning: bool = False) -> dict:
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:{mime_type};base64,{b64}"

    chosen_model = model or EXTRACTION_MODEL
    log.info("Sending image to %s for extraction (reasoning=%s)", chosen_model, reasoning)

    extra_body = _reasoning_body(chosen_model) if reasoning else {}

    response = await get_async_client().chat.completions.create(
        extra_headers={
            "HTTP-Referer": OPENROUTER_SITE_URL,
            "X-OpenRouter-Title": OPENROUTER_SITE_TITLE,
        },
        extra_body=extra_body,
        model=chosen_model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        tools=[EXTRACTION_TOOL],
        tool_choice={"type": "function", "function": {"name": "extract_invoice_data"}},
    )

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
