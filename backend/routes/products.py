from fastapi import APIRouter, Query
from rapidfuzz import process, fuzz

from config import ALL_SUPPLIERS
from services.matcher_instance import get_matcher
from services.product_matcher import _normalize, _JUNK_PREFIX_DISPLAY

router = APIRouter()


@router.get("/suppliers")
def get_suppliers():
    return {"suppliers": ALL_SUPPLIERS}


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
