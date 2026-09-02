"""
Singleton loader for ProductMatcher.
Loaded once on first request — building the index takes ~1-2s.
"""

import logging
import os
import shutil
import threading

from config import PRODUCT_LIST_PATH, PRODUCT_LIST_SHEET
from services.product_matcher import ProductMatcher

log = logging.getLogger(__name__)

_matcher: ProductMatcher | None = None

# Guards both the build path below AND routes/admin.py's catalog replacement
# (via replace_catalog_file). Two things this prevents, both confirmed live
# during development (not just reasoned about):
#   1. A "thundering herd" on cache-miss — /products/search is a sync `def`,
#      so FastAPI runs it in a thread pool; without a lock, N concurrent
#      requests hitting get_matcher() while _matcher is None would each
#      independently rebuild the entire ~11,500-family index at once.
#   2. Windows os.replace() failing with "WinError 5: Access is denied" if a
#      concurrent get_matcher() build has PRODUCT_LIST_PATH open for reading
#      at the moment of the swap — openpyxl's read-only workbook doesn't
#      grant FILE_SHARE_DELETE, which os.replace needs on the destination.
#      A first version of replace_catalog_file() didn't share this lock with
#      get_matcher() and hit exactly this under a live concurrency test
#      (search traffic hammering the endpoint while an upload was in
#      flight) — the fix is for both operations to serialize through one
#      lock, not just the replace step.
_lock = threading.Lock()


def get_matcher() -> ProductMatcher | None:
    global _matcher
    with _lock:
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


def reset_matcher() -> None:
    """Force the next get_matcher() call to rebuild from disk. Any request
    already holding a reference to the old matcher object (e.g. mid-flight
    when this is called) keeps using it safely to completion — this only
    clears the cache pointer, it doesn't touch that object."""
    global _matcher
    with _lock:
        _matcher = None
    log.info("Product matcher cache cleared — will rebuild on next request")


def replace_catalog_file(new_file_path: str) -> ProductMatcher:
    """Atomically replace PRODUCT_LIST_PATH with new_file_path's content and
    rebuild the matcher from it, all under the same lock get_matcher() uses.

    Called by routes/admin.py after a validated upload (and, for rollback,
    with a backup path). The file swap itself (copy to a same-directory temp
    file, then os.replace() into place) is what makes readers of
    PRODUCT_LIST_PATH always see either the fully-old or fully-new file,
    never a partial write — but that alone isn't enough on Windows unless
    it's also serialized against get_matcher()'s build (see _lock's comment
    above), which is why this lives here rather than as a plain file copy in
    admin.py. Raises on any failure — the file may or may not have been
    swapped depending on where it failed; the caller (admin.py) is
    responsible for backup/rollback of PRODUCT_LIST_PATH itself.
    """
    global _matcher
    with _lock:
        tmp = PRODUCT_LIST_PATH + ".new"
        shutil.copy2(new_file_path, tmp)
        os.replace(tmp, PRODUCT_LIST_PATH)
        log.info("Building product index from %s ...", PRODUCT_LIST_PATH)
        _matcher = ProductMatcher(PRODUCT_LIST_PATH, sheet=PRODUCT_LIST_SHEET)
        log.info("Catalog replaced — indexed %d families", len(_matcher.family))
        return _matcher
