import csv
import html as _html
import logging
import os

from dotenv import load_dotenv

log = logging.getLogger(__name__)

load_dotenv()

OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "")
OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"
OPENROUTER_SITE_URL: str = os.getenv("OPENROUTER_SITE_URL", "http://localhost:5173")
OPENROUTER_SITE_TITLE: str = os.getenv("OPENROUTER_SITE_TITLE", "Pharmacy Bill Extractor")

EXTRACTION_MODEL: str = os.getenv("EXTRACTION_MODEL", "google/gemini-3.1-flash-lite")
MATCHING_MODEL: str = os.getenv("MATCHING_MODEL", "google/gemini-2.5-flash-lite")

PORT: int = int(os.getenv("PORT", "3001"))
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3001").split(",")
]

DC_PIPELINE_URL: str = os.getenv("DC_PIPELINE_URL", "http://localhost:3002")

# Gates routes/admin.py (staff-list edits, product-catalog replacement) via the
# X-Admin-Pin header on every /admin/* call — this app has no other auth. Ships
# with the owner's chosen default; override via .env to rotate it.
ADMIN_PIN: str = os.getenv("ADMIN_PIN", "2009")

# Per-branch CRM login credentials (shubhadahealth.com), used by routes/browser.py.
# Must be set in .env — no defaults, since these are real login credentials.
BRANCH_CREDENTIALS: dict[str, tuple[str, str]] = {
    "HOSPET ROAD":   (os.getenv("HOSPET_ROAD_USERNAME", ""),   os.getenv("HOSPET_ROAD_PASSWORD", "")),
    "SHIVAJI CHOWK": (os.getenv("SHIVAJI_CHOWK_USERNAME", ""), os.getenv("SHIVAJI_CHOWK_PASSWORD", "")),
}
if not all(u and p for u, p in BRANCH_CREDENTIALS.values()):
    log.warning(
        "One or more branch CRM credentials are missing from .env "
        "(HOSPET_ROAD_USERNAME/PASSWORD, SHIVAJI_CHOWK_USERNAME/PASSWORD) — "
        "Launch Browser will fail to log in for that branch."
    )

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT_LIST_PATH: str = os.getenv("PRODUCT_LIST_PATH", os.path.join(_root, "Product_List.xlsx"))
PRODUCT_LIST_SHEET: str = os.getenv("PRODUCT_LIST_SHEET", "data")

def _load_names_csv(path: str, column: str, label: str) -> list[str]:
    """Shared loader for a single-column "name list" CSV (supplier_names.csv,
    staff_names.csv) — read `column`, HTML-unescape + strip each value, drop
    blanks, sort case-insensitively. `label` is just for the log line."""
    if not os.path.exists(path):
        log.warning("%s not found at %s — %s list will be empty", os.path.basename(path), path, label)
        return []
    names = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = _html.unescape(row.get(column, "")).strip()
            if name:
                names.append(name)
    log.info("Loaded %d %s from %s", len(names), label, path)
    return sorted(names, key=str.upper)


_suppliers_csv = os.path.join(_root, "supplier_names.csv")

def _load_suppliers() -> list[str]:
    return _load_names_csv(_suppliers_csv, "Supplier Name", "suppliers")

ALL_SUPPLIERS: list[str] = _load_suppliers()
KNOWN_SUPPLIERS: list[str] = ALL_SUPPLIERS  # backward compat — extract.py uses this

# Staff (employee) roster — editable via routes/admin.py, backed by staff_names.csv
# (mirrors the supplier CSV pattern above exactly). STAFF_NAMES is reassigned in
# place by reload_staff() after an admin edit, so any code that needs the CURRENT
# list at call time must read it as `config.STAFF_NAMES` via `import config`
# (module-attribute lookup) — NOT `from config import STAFF_NAMES`, which binds a
# name in the importing module's own namespace to whatever object STAFF_NAMES
# pointed to at import time and will not see a later reassignment here. See
# routes/voice.py and routes/products.py.
STAFF_CSV_PATH = os.path.join(_root, "staff_names.csv")

def _load_staff() -> list[str]:
    return _load_names_csv(STAFF_CSV_PATH, "Staff Name", "staff names")

STAFF_NAMES: list[str] = _load_staff()

def reload_staff() -> list[str]:
    """Re-read staff_names.csv and rebind the module-level STAFF_NAMES in place.
    Called by routes/admin.py after an add/remove so the change is live
    immediately, without a backend restart."""
    global STAFF_NAMES
    STAFF_NAMES = _load_staff()
    return STAFF_NAMES
