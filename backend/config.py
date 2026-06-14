import csv
import html as _html
import os

from dotenv import load_dotenv

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
    o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
]

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT_LIST_PATH: str = os.getenv("PRODUCT_LIST_PATH", os.path.join(_root, "Product_List.xlsx"))
PRODUCT_LIST_SHEET: str = os.getenv("PRODUCT_LIST_SHEET", "data")

_suppliers_csv = os.path.join(_root, "supplier_names.csv")

def _load_suppliers() -> list[str]:
    if not os.path.exists(_suppliers_csv):
        return []
    names = []
    with open(_suppliers_csv, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = _html.unescape(row.get("Supplier Name", "")).strip()
            if name:
                names.append(name)
    return sorted(names, key=str.upper)

ALL_SUPPLIERS: list[str] = _load_suppliers()
KNOWN_SUPPLIERS: list[str] = ALL_SUPPLIERS  # backward compat — extract.py uses this

STAFF_NAMES: list[str] = [
    "Abhishek Seetaram Naik",
    "Akshata",
    "Archana Gopal Marathi",
    "Chaitra G Naik",
    "Dattatraya V Hegde",
    "Deepa Manjunatha Gouda",
    "Fazil Unshalli",
    "Ganesh Hegde",
    "Harsha N",
    "Harshita Suresh Naik",
    "Keerthana M",
    "Krishnamoorthy",
    "Laxmi R Palankar",
    "Manjunata D Gosavi",
    "Mohan Gowda",
    "Narendra",
    "Netravati Prakash Kothari",
    "Nivedita M K",
    "Parashuram T Naik",
    "Pooja Naik",
    "Raghavendra",
    "Raghavendra S Palankar",
    "Renuka D H",
    "Sharath Nagendra Naik",
    "Subramanya Ganesh Hegde",
]
