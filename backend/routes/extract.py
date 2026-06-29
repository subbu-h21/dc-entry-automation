import logging
import re

from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from services.openrouter import extract_invoice_data
from services.product_matcher import match_order
from services.matcher_instance import get_matcher
from config import KNOWN_SUPPLIERS
from rapidfuzz import process, fuzz
import openai

log = logging.getLogger(__name__)
router = APIRouter()

_FREE_QTY_RE = re.compile(r'\s+(\d+)\s*\+\s*(\d+)\s*$')

_NAMED_MONTH_RE = re.compile(r'^([A-Za-z]+)([-/])(\d{2,4})$')
_MONTH_MAP = {
    'jan': '01', 'january': '01',
    'feb': '02', 'february': '02',
    'mar': '03', 'march': '03',
    'apr': '04', 'april': '04',
    'may': '05',
    'jun': '06', 'june': '06',
    'jul': '07', 'july': '07',
    'aug': '08', 'august': '08',
    'sep': '09', 'sept': '09', 'september': '09',
    'oct': '10', 'october': '10',
    'nov': '11', 'november': '11',
    'dec': '12', 'december': '12',
}


def _fix_free_qty(products: list[dict]) -> None:
    """
    Fallback: if Gemini left an 'X+Y' free-qty notation inside product_name
    (e.g. 'MIMI GOLD CAP 5+1'), strip it out and set quantity=X, free=Y.
    Only fires when the pattern is at the tail of the name, so it won't
    misfire on legitimate numeric suffixes mid-name.
    """
    for p in products:
        name = p.get("product_name", "")
        m = _FREE_QTY_RE.search(name)
        if m:
            x, y = int(m.group(1)), int(m.group(2))
            p["product_name"] = name[:m.start()].strip()
            p["quantity"] = x
            p["free"] = y


def _normalize_expiry(expiry: str) -> str:
    if not expiry:
        return expiry
    m = _NAMED_MONTH_RE.match(expiry.strip())
    if not m:
        return expiry
    month_num = _MONTH_MAP.get(m.group(1).lower())
    if not month_num:
        return expiry
    sep = m.group(2)
    year = m.group(3)[-2:]  # handles both YY and YYYY
    return f"{month_num}{sep}{year}"


def _fix_expiry(products: list[dict]) -> None:
    for p in products:
        p['expiry'] = _normalize_expiry(p.get('expiry', ''))


_NON_ALNUM_RE = re.compile(r'[^A-Za-z0-9]')

def _fix_batch(products: list[dict]) -> None:
    for p in products:
        p['batch_number'] = _NON_ALNUM_RE.sub('', p.get('batch_number', ''))


def _match_supplier(extracted: str) -> str:
    """Fuzzy-map an extracted supplier string to the nearest known supplier."""
    if not extracted:
        return ""
    hit = process.extractOne(extracted.upper(), KNOWN_SUPPLIERS, scorer=fuzz.WRatio)
    return hit[0] if hit and hit[1] >= 55 else ""


ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"}
MAX_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/extract")
async def extract(
    image: UploadFile = File(...),
    model: str | None = Form(None),
    reasoning: bool = Form(False),
    product_image: UploadFile | None = File(None),
):
    if not image:
        raise HTTPException(status_code=400, detail="No image provided.")

    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f'Invalid file type "{image.content_type}". Allowed: JPEG, PNG, WebP, GIF.',
        )

    image_bytes = await image.read()

    if len(image_bytes) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Maximum size is 10 MB.")

    product_image_bytes: bytes | None = None
    product_image_mime: str | None = None
    if product_image and product_image.filename:
        if product_image.content_type not in ALLOWED_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f'Invalid product image type "{product_image.content_type}". Allowed: JPEG, PNG, WebP, GIF.',
            )
        product_image_bytes = await product_image.read()
        if len(product_image_bytes) > MAX_SIZE:
            raise HTTPException(status_code=400, detail="Product image too large. Maximum size is 10 MB.")
        product_image_mime = product_image.content_type

    try:
        # Step 1 — Gemini extracts product_name / quantity / batch_number
        result = await extract_invoice_data(
            image_bytes, image.content_type,
            model=model, reasoning=reasoning,
            product_image_bytes=product_image_bytes,
            product_image_mime=product_image_mime,
        )
        products = result.get("products", [])

        # Step 1b — Apply X+Y free-qty rule (fallback if Gemini missed it)
        _fix_free_qty(products)

        # Step 1c — Normalize named-month expiry (e.g. "dec/27" → "12/27")
        _fix_expiry(products)

        # Step 1d — Strip non-alphanumeric chars from batch numbers
        _fix_batch(products)

        # Step 2 — Match each extracted name to CRM catalog
        matcher = get_matcher()
        if matcher and products:
            medicines = [
                {
                    "medicine_text": p["product_name"],
                    "quantity":      p["quantity"],
                    "batch":         p["batch_number"],
                }
                for p in products
            ]
            matched = await match_order(medicines, matcher)

            for i, m in enumerate(matched):
                products[i]["matched_product"]  = m.get("matched_product")
                products[i]["matched_pack"]     = m.get("matched_pack")
                products[i]["match_confidence"] = m.get("match_confidence")
                products[i]["not_stocked"]      = m.get("not_stocked", False)
                products[i]["top_candidates"]   = m.get("top_candidates", [])
                products[i]["gemini_pick"]      = m.get("gemini_pick")
        else:
            for p in products:
                p["matched_product"]  = None
                p["matched_pack"]     = None
                p["match_confidence"] = None
                p["not_stocked"]      = False
                p["top_candidates"]   = []
                p["gemini_pick"]      = None

        raw_supplier = result.get("supplier_name", "")
        matched_supplier = _match_supplier(raw_supplier)

        return JSONResponse(content={
            "dc_number":        result.get("dc_number", ""),
            "dc_date":          result.get("dc_date", ""),
            "supplier_name":    matched_supplier,
            "products":         products,
        })

    except openai.AuthenticationError:
        raise HTTPException(status_code=401, detail="Invalid API key. Check OPENROUTER_API_KEY.")
    except openai.NotFoundError as e:
        log.error("Model not found: %s", e)
        raise HTTPException(status_code=404, detail=f"Model not found on OpenRouter. Check the model ID. ({e})")
    except openai.BadRequestError as e:
        log.error("Bad request to OpenRouter: %s", e)
        raise HTTPException(status_code=400, detail=f"Model rejected the request (tool calling may not be supported): {e}")
    except openai.RateLimitError:
        raise HTTPException(status_code=429, detail="Rate limit reached. Please retry.")
    except openai.APITimeoutError:
        raise HTTPException(status_code=504, detail="AI service timed out. Please retry.")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        log.exception("Unhandled error in /extract")
        raise HTTPException(status_code=500, detail=str(e))
