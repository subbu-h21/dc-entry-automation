import logging

from fastapi import APIRouter, Query
from rapidfuzz import process, fuzz

import config
from config import ALL_SUPPLIERS
from services.matcher_instance import get_matcher
from services.product_matcher import _normalize, _JUNK_PREFIX_DISPLAY

router = APIRouter()
log = logging.getLogger(__name__)


@router.get("/suppliers")
def get_suppliers():
    log.info("GET /suppliers — returning %d suppliers", len(ALL_SUPPLIERS))
    return {"suppliers": ALL_SUPPLIERS}


@router.get("/staff")
def get_staff():
    # Read config.STAFF_NAMES live (not a top-level `from config import
    # STAFF_NAMES`) so an admin-page edit shows up here immediately — see the
    # staleness-binding note in config.py and routes/voice.py.
    log.info("GET /staff — returning %d staff names", len(config.STAFF_NAMES))
    return {"staff": config.STAFF_NAMES}


@router.get("/products/search")
def search_products(q: str = Query("", min_length=1)):
    if len(q.strip()) < 2:
        return {"results": []}

    matcher = get_matcher()
    if not matcher:
        return {"results": []}

    # Flatten entire catalog once per request (rapidfuzz is fast enough at ~2k items)
    all_products = [item for items in matcher.family.values() for item in items]
    if not all_products:
        return {"results": []}

    q_norm = _normalize(q)
    norms  = [p["_norm"] for p in all_products]
    hits   = process.extract(q_norm, norms, scorer=fuzz.WRatio, limit=10)

    results = []
    for (_val, score, idx) in hits:
        p = all_products[idx]
        results.append({
            "product": _JUNK_PREFIX_DISPLAY.sub("", p["product"]).lstrip(),
            "pack":    p["pack"],
            "score":   round(float(score), 1),
        })

    return {"results": results}
