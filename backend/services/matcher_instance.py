"""
Singleton loader for ProductMatcher.
Loaded once on first request — building the index takes ~1-2s.
"""

import logging
import os

from config import PRODUCT_LIST_PATH, PRODUCT_LIST_SHEET
from services.product_matcher import ProductMatcher

log = logging.getLogger(__name__)

_matcher: ProductMatcher | None = None


def get_matcher() -> ProductMatcher | None:
    global _matcher
    if _matcher is not None:
        return _matcher

    path = PRODUCT_LIST_PATH or os.getenv("PRODUCT_LIST_PATH", "")
    if not path or not os.path.exists(path):
        log.warning("PRODUCT_LIST_PATH not set or file not found — matching disabled")
        return None

    log.info("Building product index from %s ...", path)
    _matcher = ProductMatcher(path, sheet=PRODUCT_LIST_SHEET)
    log.info("Indexed %d families", len(_matcher.family))
    return _matcher
