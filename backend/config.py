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

KNOWN_SUPPLIERS: list[str] = [
    "KAPILA PHARMA",
    "KAPILA MEDICAL AGENCIES",
    "SAROJ PHARMA",
    "HEGDE BROTHERS",
    "DONNA ASSOCIATES",
    "A.K.PHARMA",
    "DHANYA PHARMA",
]
