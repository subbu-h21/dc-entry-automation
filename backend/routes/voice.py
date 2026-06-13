import asyncio
import json
import logging

import requests
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from config import ELEVENLABS_API_KEY, MATCHING_MODEL
from services.client import get_async_client

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/voice")

_ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text"

_SYSTEM_PROMPT = """\
You are a voice command parser for a pharmaceutical invoice editing tool.
The user speaks correction commands for a table of extracted invoice rows.

Your job: parse the command into field updates and return ONLY a JSON object in this exact shape:
{"updates": [{"row": <0-based index>, "field": "<field_name>", "value": <new_value>}, ...]}

Valid field names:
  quantity     — also "qty"
  mrp          — also "MRP"
  old_mrp      — also "old MRP", "old mrp"
  rate         — also "rate"
  disc_percent — also "discount", "disc", "disc%"
  free         — also "free qty", "free quantity"
  batch_number — also "batch", "batch no", "batch number"
  expiry       — also "expiry", "expiry date", "exp"
  product_name — also "product", "name", "item"

Conversion rules:
  - "row 1" / "first row" / "1st row"  → row index 0
  - "row 2" / "second row" / "2nd row" → row index 1  (and so on)
  - If the user mentions a product name instead of a row number, match it to the closest row by name
  - Numeric values must be JSON numbers, not strings
  - Expiry like "9/27", "nine slash twenty seven", "sep 27", "9 27" → "9/27"
  - A command may update multiple fields or multiple rows — include all as separate items
  - If the command cannot be parsed, return {"updates": []}

Examples:
  "row 1 change qty to 5"          → {"updates": [{"row": 0, "field": "quantity", "value": 5}]}
  "second row expiry 11/27"        → {"updates": [{"row": 1, "field": "expiry", "value": "11/27"}]}
  "row 3 MRP 150.50 and rate 120"  → {"updates": [{"row": 2, "field": "mrp", "value": 150.5}, {"row": 2, "field": "rate", "value": 120}]}
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
        if not isinstance(updates, list):
            updates = []
    except (json.JSONDecodeError, AttributeError):
        logger.warning("Could not parse Gemini response: %r", completion.choices[0].message.content[:200])
        updates = []

    logger.info("Voice updates: %s", updates)
    return {"transcription": transcription, "updates": updates}
