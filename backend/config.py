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
MARKS_MODEL: str = os.getenv("MARKS_MODEL", "google/gemini-3.7-flash")

PORT: int = int(os.getenv("PORT", "3001"))
ALLOWED_ORIGINS: list[str] = [
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3001").split(",")
]

DC_PIPELINE_URL: str = os.getenv("DC_PIPELINE_URL", "http://localhost:3002")

# Gates routes/admin.py (product-catalog replacement) via the
# X-Admin-Pin header on every /admin/* call — this app has no other auth. Ships
# with the owner's chosen default; override via .env to rotate it.
ADMIN_PIN: str = os.getenv("ADMIN_PIN", "2009")

# CRM DC Inward API, used by services/crm_api.py. CRM_API_BASE_URL has no default
# on purpose: a save raises real stock, so this app must never reach a CRM that
# nobody explicitly pointed it at.
CRM_API_BASE_URL: str = os.getenv("CRM_API_BASE_URL", "").rstrip("/")
CRM_CLIENT_ID: str = os.getenv("CRM_CLIENT_ID", "")
CRM_CLIENT_SECRET: str = os.getenv("CRM_CLIENT_SECRET", "")

# Created By when the Checked By person isn't set up for the branch in the CRM.
CRM_DEFAULT_EMPLOYEE_ID: int = int(os.getenv("CRM_DEFAULT_EMPLOYEE_ID", "0") or 0)

# The frontend's branch names -> the CRM's branch ids.
CRM_BRANCH_IDS: dict[str, int] = {
    "HOSPET ROAD":   int(os.getenv("CRM_BRANCH_ID_HOSPET_ROAD", "2")),
    "SHIVAJI CHOWK": int(os.getenv("CRM_BRANCH_ID_SHIVAJI_CHOWK", "1")),
}
if not (CRM_API_BASE_URL and CRM_CLIENT_ID and CRM_CLIENT_SECRET and CRM_DEFAULT_EMPLOYEE_ID):
    log.warning(
        "CRM API settings are missing from .env (CRM_API_BASE_URL, CRM_CLIENT_ID, "
        "CRM_CLIENT_SECRET, CRM_DEFAULT_EMPLOYEE_ID) — the supplier and staff lists "
        "and Save to CRM won't work."
    )

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT_LIST_PATH: str = os.getenv("PRODUCT_LIST_PATH", os.path.join(_root, "Product_List.xlsx"))
PRODUCT_LIST_SHEET: str = os.getenv("PRODUCT_LIST_SHEET", "data")
