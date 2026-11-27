"""
A second look at an extracted table: Claude compares the table with the DC photo and
lists the cells that look wrong. It never changes anything; staff decide on the page.
Any failure is reported as "couldn't run", never answered by a weaker model, because a
second opinion is only worth having from a strong one.
"""

import asyncio
import base64
import json
import logging

from config import ANTHROPIC_KEY, REVIEW_MODEL
from services.client import get_anthropic_client
from services.openrouter import _fit_for_claude

log = logging.getLogger(__name__)

_MAX_TOKENS = 16000  # as much room as extraction: thinking is always on, and a big DC needs it
# Staff read the reasons in English and Kannada.
_KN_DESCRIPTION = (
    "The same sentence as reason, in simple everyday Kannada (Kannada script), as a pharmacy "
    "store worker would say it. Keep product names, batch numbers, numbers and words like "
    "Qty, Rate, MRP and Batch as they are."
)
ROW_FIELDS = ["product_name", "matched_product", "batch_number", "expiry", "old_mrp", "mrp", "rate", "quantity", "free", "disc_percent"]
HEADER_FIELDS = ["dc_number", "dc_date"]

_TOOL = {
    "type": "function",
    "function": {
        "name": "report_table_issues",
        "description": "Report every cell of the table that doesn't match the delivery note, and any printed row missing from the table.",
        "parameters": {
            "type": "object",
            "properties": {
                "issues": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "row": {"type": "integer", "description": "The table's row number (1 = first row). 0 for dc_number and dc_date."},
                            "field": {"type": "string", "enum": ROW_FIELDS + HEADER_FIELDS},
                            "seen_on_dc": {"type": "string", "description": "What the delivery note actually shows for this cell. Numbers as plain numbers, expiry as MM/YY, dc_date as YYYY-MM-DD."},
                            "reason": {"type": "string", "description": "One short sentence."},
                            "reason_kn": {"type": "string", "description": _KN_DESCRIPTION},
                        },
                        "required": ["row", "field", "seen_on_dc", "reason", "reason_kn"],
                    },
                },
                "missing_rows": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "product_name": {"type": "string", "description": "The printed name of a product row that is not in the table."},
                            "reason": {"type": "string"},
                            "reason_kn": {"type": "string", "description": _KN_DESCRIPTION},
                        },
                        "required": ["product_name", "reason", "reason_kn"],
                    },
                },
            },
            "required": ["issues", "missing_rows"],
        },
    },
}

_PROMPT = """You are checking a table that was read from the photo of a pharmacy delivery note \
(DC). The photo may be sideways. Compare every row and every cell of the table below with \
the PRINTED delivery note, and call the report_table_issues tool once with what you find.

Report a cell only when the printed value clearly differs from the table. Don't report:
- formatting differences (9/27 vs 09/27, SEP-27 vs 09/27, 173 vs 173.00, spaces, dashes or \
slashes in a batch or the DC number: the table leaves those out on purpose);
- handwriting, ticks, stamps or pen marks: only printed values count;
- a cell you can't read clearly on the photo.

Notes on the columns:
- quantity is the paid quantity and free the free quantity. A note like "5+1" means quantity 5, free 1.
- disc_percent is the discount column, never GST or any tax column.
- matched_product is the product chosen from the pharmacy's own catalogue for that row. \
Report it when it is clearly a different product from the printed one (another variant, \
strength, form or pack, e.g. "EYEMAC EYE DROPS" for a printed "EYEMAC GB EYE DROPS"), and \
put the printed name in seen_on_dc.
- dc_number and dc_date are the delivery note's number and date (row 0); check the year carefully.

List any printed product row that is missing from the table under missing_rows. If everything \
matches, report empty lists.

Staff read English and Kannada, so write every reason twice: reason in short plain English, and \
reason_kn, the same sentence in simple everyday Kannada (Kannada script), keeping product \
names, batch numbers, numbers and words like Qty, Rate, MRP and Batch as they are.

The table:
"""


def _table_text(table: dict) -> str:
    rows = table.get("products") if isinstance(table.get("products"), list) else []
    lines = [f'dc_number: {table.get("dc_number", "")!s}', f'dc_date: {table.get("dc_date", "")!s}']
    for i, r in enumerate(rows, 1):
        r = r if isinstance(r, dict) else {}
        cells = {f: r.get(f) for f in ROW_FIELDS}
        cells["matched_pack"] = r.get("matched_pack")
        lines.append(f"row {i}: " + json.dumps(cells, ensure_ascii=False))
    return "\n".join(lines)


def _with_kannada(entry: dict, item: dict) -> dict:
    """Adds the Kannada reason when Claude gave one. A flag without it still shows, in English."""
    kn = item.get("reason_kn")
    if isinstance(kn, str) and kn.strip():
        entry["reason_kn"] = kn.strip()[:300]
    return entry


def _clean(parsed: dict, row_count: int) -> dict:
    """Keeps only flags the page can show against a real cell."""
    issues, seen_keys = [], set()
    for item in parsed.get("issues") if isinstance(parsed.get("issues"), list) else []:
        if not isinstance(item, dict):
            continue
        field, row, seen, reason = item.get("field"), item.get("row"), item.get("seen_on_dc"), item.get("reason")
        if not isinstance(seen, str) or not isinstance(reason, str) or not seen.strip():
            continue
        if field in HEADER_FIELDS:
            flag = {"row": None, "field": field, "seen": seen.strip()[:80], "reason": reason.strip()[:200]}
        elif field in ROW_FIELDS and isinstance(row, int) and not isinstance(row, bool) and 1 <= row <= row_count:
            flag = {"row": row - 1, "field": field, "seen": seen.strip()[:80], "reason": reason.strip()[:200]}
        else:
            continue
        key = (flag["row"], flag["field"], flag["seen"])  # the same cell reported twice is one flag
        if key not in seen_keys:
            seen_keys.add(key)
            issues.append(_with_kannada(flag, item))
    missing = []
    for item in parsed.get("missing_rows") if isinstance(parsed.get("missing_rows"), list) else []:
        if isinstance(item, dict) and isinstance(item.get("product_name"), str) and item["product_name"].strip():
            missing.append(_with_kannada({"product_name": item["product_name"].strip()[:120], "reason": str(item.get("reason") or "")[:200]}, item))
    return {"issues": issues, "missing_rows": missing}


async def review_table(pages: list[tuple[bytes, str]], table: dict) -> dict:
    """Raises on any failure; the route turns that into "couldn't run"."""
    if not ANTHROPIC_KEY:
        raise ValueError("ANTHROPIC_KEY is not set")
    rows = table.get("products") if isinstance(table.get("products"), list) else []
    fitted = [await asyncio.to_thread(_fit_for_claude, *page) for page in pages]
    content: list[dict] = [{"type": "text", "text": _PROMPT + _table_text(table)}]
    for data, mime in fitted:
        content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}})

    response = await get_anthropic_client().chat.completions.create(
        model=REVIEW_MODEL,
        max_tokens=_MAX_TOKENS,
        messages=[{"role": "user", "content": content}],
        tools=[_TOOL],
        tool_choice="auto",
    )
    if getattr(response.choices[0], "finish_reason", None) == "length":
        raise ValueError("the second check ran out of room")
    calls = response.choices[0].message.tool_calls or []
    call = next((c for c in calls if c.function.name == "report_table_issues"), None)
    if call is None:
        raise ValueError("the second check gave no report")
    result = _clean(json.loads(call.function.arguments), len(rows))
    log.info("Second check: %d issue(s), %d missing row(s)", len(result["issues"]), len(result["missing_rows"]))
    return result
