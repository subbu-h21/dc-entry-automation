import logging
import re
import uuid

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from config import CRM_BRANCH_IDS, DC_PIPELINE_URL
from services import crm_api, pen_marks

router = APIRouter(prefix="/crm/dc")
log = logging.getLogger(__name__)

# Our own question, alongside the CRM's: the CRM accepts a rate of 0 without
# asking, and an unread rate comes out of extraction as exactly that.
_RATE_ZERO = "RATE_ZERO"


class DcRow(BaseModel):
    row: int                 # position in the review table, so answers map back
    matched_product: str = ""
    matched_pack: str = ""   # some CRM products share a name and differ only by pack
    batch_number: str = ""
    expiry: str = ""
    mrp: float = 0
    rate: float = 0
    quantity: float = 0
    free: float = 0
    disc_percent: float = 0
    confirm: list[str] = []

    # A voice edit can turn an all-digit batch into a number, and extraction can
    # leave a field empty. Neither should fail as a bare 422.
    @field_validator("matched_product", "matched_pack", "batch_number", "expiry", mode="before")
    @classmethod
    def _text(cls, value: object) -> str:
        return "" if value is None else str(value)

    @field_validator("mrp", "rate", "quantity", "free", "disc_percent", mode="before")
    @classmethod
    def _number(cls, value: object) -> object:
        return 0 if value in (None, "") else value


class DcRequest(BaseModel):
    dc_number: str = ""
    dc_date: str = ""        # YYYY-MM-DD from the frontend date input
    supplier: str = ""
    checked_by: str = ""
    branch: str = ""
    scan_id: str = ""        # from /extract, when the photo has red pen marks
    rows: list[DcRow] = []
    confirm: list[str] = []  # header-level question codes


class DcSaveRequest(DcRequest):
    save_key: str = Field(min_length=8, max_length=100)


class _Prepared:
    def __init__(self, body: dict, line_rows: list[int], unresolved: list[dict], rate_zero: list[DcRow],
                 branch_id: int, employee_id: int, supplier_name: str, checked_by_name: str):
        self.body = body
        self.line_rows = line_rows       # CRM line N (1-based) -> line_rows[N-1] = our table row
        self.unresolved = unresolved     # rows with no CRM product, as errors
        self.rate_zero = rate_zero
        self.branch_id = branch_id
        self.employee_id = employee_id
        self.supplier_name = supplier_name
        self.checked_by_name = checked_by_name


def _fmt_expiry(expiry: str) -> str:
    """Normalise expiry to the MM/YY the CRM wants (it refuses "08-27" and "0827").

    Anything not clearly understood is returned unchanged, so the CRM refuses it
    and staff see a red row. A wrong guess here would go straight into stock.
    """
    text = expiry.strip()
    parts = [p for p in re.split(r"[-/.\s]+", text) if p]
    if not parts or not all(p.isascii() and p.isdigit() for p in parts):
        return text

    if len(parts) == 1 and len(parts[0]) in (3, 4, 6):       # 927, 0927, 092027
        digits = parts[0].zfill(4) if len(parts[0]) == 3 else parts[0]
        month, year = digits[:2], digits[2:]
    elif len(parts) == 2:                                    # 09/27, 09/2027, 2027-09
        month, year = (parts[1], parts[0]) if len(parts[0]) == 4 else (parts[0], parts[1])
    elif len(parts) == 3:                                    # 2027-09-30, 30/09/2027
        month, year = (parts[1], parts[0]) if len(parts[0]) == 4 else (parts[1], parts[2])
    else:
        return text

    # A 4-digit year has to be this century. That also stops a DDMMYY like
    # 120927 being read as month 12 of the year 0927.
    if not 1 <= int(month) <= 12 or len(year) not in (2, 4) or (len(year) == 4 and not year.startswith("20")):
        return text
    return f"{int(month):02d}/{year[-2:]}"


async def _prepare(details: DcRequest) -> _Prepared:
    required = {
        "DC Number": details.dc_number.strip(),
        "DC Date": details.dc_date.strip(),
        "Supplier": details.supplier.strip(),
        "Checked By": details.checked_by.strip(),
    }
    missing = [label for label, value in required.items() if not value]
    if missing:
        raise HTTPException(status_code=400, detail=f"Fill in first: {', '.join(missing)}.")
    if not details.rows:
        raise HTTPException(status_code=400, detail="There are no rows to send.")

    branch_id = CRM_BRANCH_IDS.get(details.branch)
    if branch_id is None:
        raise HTTPException(status_code=400, detail=f'Unknown branch "{details.branch}".')

    supplier = await crm_api.supplier_lookup(details.supplier)
    if supplier is None:
        raise HTTPException(status_code=400, detail=f'Supplier "{details.supplier}" isn\'t in the CRM list. Choose it again.')
    checked_by = await crm_api.employee_lookup(details.checked_by)
    if checked_by is None:
        raise HTTPException(status_code=400, detail=f'Checked By "{details.checked_by}" isn\'t in the CRM list. Choose again.')

    product_ids = await crm_api.find_product_ids([(r.matched_product, r.matched_pack) for r in details.rows], branch_id)

    lines: list[dict] = []
    line_rows: list[int] = []
    unresolved: list[dict] = []
    for row, product_id in zip(details.rows, product_ids):
        if product_id == crm_api.AMBIGUOUS:
            unresolved.append({
                "code": "PRODUCT_AMBIGUOUS",
                "row": row.row,
                "product": row.matched_product,
                "message": f'The CRM has more than one "{row.matched_product}" and the pack doesn\'t show which. Enter this row on the CRM screen.',
            })
            continue
        if product_id is None:
            unresolved.append({
                "code": "PRODUCT_NOT_IN_CRM",
                "row": row.row,
                "product": row.matched_product,
                "message": f'"{row.matched_product}" wasn\'t found in the CRM. Choose another product with Change.',
            })
            continue
        lines.append({
            "productId": product_id,
            "batchNumber": row.batch_number.strip(),
            "expiry": _fmt_expiry(row.expiry),
            "mrp": row.mrp,
            "rate": row.rate,
            "quantity": row.quantity,
            "freeQuantity": row.free,
            "discountPercent": row.disc_percent,
            "confirm": [code for code in row.confirm if code != _RATE_ZERO],
        })
        line_rows.append(row.row)

    body = {
        "dcNumber": details.dc_number.strip(),
        "dcDate": details.dc_date.strip(),
        "supplierId": supplier[0],
        "checkedByEmployeeId": checked_by[0],
        "confirm": details.confirm,
        "lines": lines,
    }
    resolved = set(line_rows)
    rate_zero = [r for r in details.rows if r.rate <= 0 and r.row in resolved]
    # The CRM spells some suppliers with double spaces ("RAJESH  PHARMA"). dc_pipeline
    # matches on the exact name, so as written each save would add a near-duplicate.
    supplier_name = " ".join(supplier[1].split())
    return _Prepared(body, line_rows, unresolved, rate_zero, branch_id, checked_by[0], supplier_name, checked_by[1])


def _finish_report(report: dict, prepared: _Prepared) -> dict:
    """Adds our own findings to the CRM's report. A fresh save key comes with
    every report, so a retried save reuses one key and a changed DC never does."""
    questions = report["questions"] + [{
        "code": _RATE_ZERO,
        "row": r.row,
        "product": r.matched_product,
        "message": "Rate is 0. Is that right?",
    } for r in prepared.rate_zero]
    return {
        "errors": prepared.unresolved + report["errors"],
        "questions": questions,
        "net_amount": report["net_amount"],
        "sent_rows": len(prepared.line_rows),
        "save_key": uuid.uuid4().hex,
    }


async def _report_stage3(details: DcRequest, supplier_name: str, checked_by_name: str, reference_no: str) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(
                f"{DC_PIPELINE_URL}/stage3/save",
                data={
                    "dc_number": details.dc_number.strip(),
                    "supplier_name": supplier_name,
                    "checked_by": checked_by_name,
                    "reference_no": reference_no,
                },
            )
            resp.raise_for_status()
        log.info(
            "Reported Stage 3 save to dc_pipeline: dc=%s checked_by=%r ref=%r",
            details.dc_number, checked_by_name, reference_no,
        )
        # dc_pipeline accepts a name it doesn't know and stores the save with no
        # employee, so a 200 alone doesn't mean anyone got the credit.
        return resp.json().get("matched_employee", True) is not False
    except (ValueError, AttributeError):
        return True
    except Exception as e:
        # The DC is already in the CRM by now, so nothing here may fail the save.
        log.warning("Failed to report Stage 3 save to dc_pipeline: %s", type(e).__name__)
        return False


@router.post("/check")
async def check_dc(details: DcRequest):
    """Runs the CRM's checks. Saves nothing."""
    try:
        prepared = await _prepare(details)
        if prepared.line_rows:
            report = await crm_api.check_dc(
                prepared.body, prepared.branch_id, prepared.employee_id, prepared.line_rows,
            )
        else:
            report = {"errors": [], "questions": [], "net_amount": None}
    except crm_api.CrmError as e:
        raise HTTPException(status_code=502, detail=e.message)
    return _finish_report(report, prepared)


@router.get("/products/search")
async def search_products(q: str = "", branch: str = "", supplier: str = ""):
    """The Change box's search, straight from the CRM's products. Reads only."""
    text = q.strip()[:100]
    if len(text) < 2:
        return {"results": [], "cut_short": False}
    branch_id = CRM_BRANCH_IDS.get(branch)
    if branch_id is None:
        raise HTTPException(status_code=400, detail=f'Unknown branch "{branch}".')
    supplier_id = None
    if supplier.strip():
        try:
            found = await crm_api.supplier_lookup(supplier)
        except crm_api.CrmError:
            found = None  # the search works without the supplier, just without its products first
        supplier_id = found[0] if found else None
    try:
        results, cut_short = await crm_api.search_products(text, branch_id, supplier_id)
    except crm_api.CrmError as e:
        raise HTTPException(status_code=502, detail=e.message)
    return {"results": results, "cut_short": cut_short}


@router.post("/save")
async def save_dc(details: DcSaveRequest):
    """Saves the DC to the CRM. Stock goes up immediately.

    {"saved": false} comes with a new report and a new key. 400 and 409 mean it
    definitely wasn't saved and a new check is needed. Anything else, 504
    included, means the outcome is unknown: the frontend retries the exact same
    request with the same save_key, which the CRM treats as the same save.
    """
    try:
        prepared = await _prepare(details)

        unconfirmed_rate = [r for r in prepared.rate_zero if _RATE_ZERO not in r.confirm]
        if prepared.unresolved or unconfirmed_rate or not prepared.line_rows:
            report = {"errors": [], "questions": [], "net_amount": None}
            return {"saved": False, "report": _finish_report(report, prepared)}

        result = await crm_api.save_dc(
            prepared.body, prepared.branch_id, prepared.employee_id, prepared.line_rows, details.save_key,
        )
    except crm_api.CrmRefused as e:
        raise HTTPException(status_code=409, detail=f"{e.message} Check the DC again before retrying.")
    except crm_api.CrmError as e:
        message = e.message if "still saving" in e.message else "Not sure if this saved. Click Save again, it can't create a duplicate."
        raise HTTPException(status_code=504, detail=message)

    if not result["saved"]:
        return {"saved": False, "report": _finish_report(result["report"], prepared)}

    stage3_reported = await _report_stage3(
        details, prepared.supplier_name, prepared.checked_by_name, result["ref_no"],
    )
    pen_marks.report_later(details.scan_id, details.dc_number.strip(), prepared.supplier_name, result["ref_no"])
    return {"saved": True, "ref_no": result["ref_no"], "stage3_reported": stage3_reported}
