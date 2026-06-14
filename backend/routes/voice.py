import asyncio
import json
import logging

import requests
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from rapidfuzz import process, fuzz

from config import ALL_SUPPLIERS, ELEVENLABS_API_KEY, MATCHING_MODEL, STAFF_NAMES
from services.client import get_async_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/voice")

_ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text"

_STAFF_UPPER     = [n.upper() for n in STAFF_NAMES]
_SUPPLIERS_UPPER = [n.upper() for n in ALL_SUPPLIERS]


def _match_staff(value: str) -> str:
    if not value:
        return value
    hit = process.extractOne(value.upper(), _STAFF_UPPER, scorer=fuzz.WRatio)
    if hit and hit[1] >= 60:
        return STAFF_NAMES[hit[2]]
    return value


def _match_supplier_voice(value: str) -> str:
    if not value:
        return value
    hit = process.extractOne(value.upper(), _SUPPLIERS_UPPER, scorer=fuzz.WRatio)
    if hit and hit[1] >= 60:
        return ALL_SUPPLIERS[hit[2]]
    return value

_SYSTEM_PROMPT = """\
You are a voice command parser for a pharmaceutical invoice editing tool.
The user speaks correction commands for either the product table rows OR the DC header fields.

Return ONLY a JSON object in this exact shape:
{"updates": [...], "dc_updates": [...]}

## Product table fields (put in "updates"):
  quantity     — also "qty"
  mrp          — also "MRP"
  old_mrp      — also "old MRP", "old mrp"
  rate         — also "rate"
  disc_percent — also "discount", "disc", "disc%"
  free         — also "free qty", "free quantity"
  batch_number — also "batch", "batch no", "batch number"
  expiry       — also "expiry", "expiry date", "exp"
  product_name — also "product", "name", "item"

Each product update: {"row": <0-based index>, "field": "<field_name>", "value": <new_value>}
  - "row 1" / "first row" / "1st row" → row index 0  (and so on)
  - If the user mentions a product name instead of a row number, match it to the closest row by name
  - Numeric values must be JSON numbers, not strings
  - Expiry like "9/27", "nine slash twenty seven", "sep 27" → "9/27"

## DC header fields (put in "dc_updates"):
  dc_number  — also "DC number", "invoice number", "bill number"
  dc_date    — also "date", "invoice date" — always format value as YYYY-MM-DD
  supplier   — also "supplier", "vendor" — return the name exactly as spoken
  checked_by — also "checked by", "verified by"

Each DC update: {"field": "<dc_field_name>", "value": "<string_value>"}

General rules:
  - A command may update multiple fields — include all as separate items
  - If the command cannot be parsed, return {"updates": [], "dc_updates": []}

Examples:
  "row 1 change qty to 5"        → {"updates": [{"row": 0, "field": "quantity", "value": 5}], "dc_updates": []}
  "DC number is DC-12345"        → {"updates": [], "dc_updates": [{"field": "dc_number", "value": "DC-12345"}]}
  "supplier is KAPILA PHARMA"    → {"updates": [], "dc_updates": [{"field": "supplier", "value": "KAPILA PHARMA"}]}
  "date is 15th December 2025"   → {"updates": [], "dc_updates": [{"field": "dc_date", "value": "2025-12-15"}]}
  "checked by GANESH"            → {"updates": [], "dc_updates": [{"field": "checked_by", "value": "GANESH HEGDE"}]}
"""

_USER_TEMPLATE = """\
Voice command: "{transcription}"

Current table rows:
{rows_context}
"""


@router.post("/command")
async def voice_command(
    audio: UploadFile = File(...),
    products: str = Form(...),
):
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=500, detail="ELEVENLABS_API_KEY is not configured")

    # ── 1. Transcribe via ElevenLabs Scribe v2 ─────────────────
    audio_bytes = await audio.read()
    mime = audio.content_type or "audio/webm"
    filename = audio.filename or "recording.webm"

    def _transcribe_sync():
        response = requests.post(
            _ELEVENLABS_URL,
            headers={"xi-api-key": ELEVENLABS_API_KEY},
            data=[
                ("model_id", "scribe_v2"),
                ("language_code", "eng"),
                ("no_verbatim", "true"),
                ("keyterms", "free"),
            ],
            files={"file": (filename, audio_bytes, mime)},
            timeout=30,
        )
        return response

    resp = await asyncio.get_event_loop().run_in_executor(None, _transcribe_sync)

    if not resp.ok:
        logger.error("ElevenLabs error %d: %s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail=f"Transcription failed: {resp.text[:120]}")

    transcription: str = resp.json().get("text", "").strip()
    logger.info("Voice transcription: %r", transcription)

    if not transcription:
        return JSONResponse({"transcription": "", "updates": []})

    # ── 2. Parse intent via Gemini (OpenRouter) ─────────────────
    products_data: list[dict] = json.loads(products)
    rows_context = "\n".join(
        "Row {n}: {name} | qty={qty} | batch={batch} | expiry={exp} | mrp={mrp} | rate={rate} | disc={disc}%".format(
            n=i + 1,
            name=p.get("product_name", ""),
            qty=p.get("quantity"),
            batch=p.get("batch_number", ""),
            exp=p.get("expiry", ""),
            mrp=p.get("mrp"),
            rate=p.get("rate"),
            disc=p.get("disc_percent"),
        )
        for i, p in enumerate(products_data)
    )

    user_msg = _USER_TEMPLATE.format(transcription=transcription, rows_context=rows_context)

    client = get_async_client()
    completion = await client.chat.completions.create(
        model=MATCHING_MODEL,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
        ],
        timeout=20,
    )

    try:
        parsed = json.loads(completion.choices[0].message.content)
        updates = parsed.get("updates", [])
        dc_updates = parsed.get("dc_updates", [])
        if not isinstance(updates, list):
            updates = []
        if not isinstance(dc_updates, list):
            dc_updates = []
    except (json.JSONDecodeError, AttributeError):
        logger.warning("Could not parse Gemini response: %r", completion.choices[0].message.content[:200])
        updates = []
        dc_updates = []

    for u in dc_updates:
        if u.get("field") == "checked_by":
            u["value"] = _match_staff(u["value"])
        elif u.get("field") == "supplier":
            u["value"] = _match_supplier_voice(u["value"])

    logger.info("Voice updates: %s | DC updates: %s", updates, dc_updates)
    return {"transcription": transcription, "updates": updates, "dc_updates": dc_updates}
