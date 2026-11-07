"""
Records supplier mistakes from red pen marks on a DC.

Staff use a normal pen for ticks and a red pen only when something on the
supplier's DC is wrong. When an uploaded invoice page has red on it, an AI pass
reads those marks in the background while staff work on the table. After the DC
is saved to the CRM, the marks and the photo go to dc_pipeline, whose dashboard
keeps them as the record of that supplier's mistakes.

None of this may ever affect extraction or saving: every failure here is logged
and swallowed, and nothing in this module is waited on by a request.
"""

import asyncio
import base64
import io
import json
import logging
import time
import uuid

import httpx
from PIL import Image, ImageChops

from config import DC_PIPELINE_URL, MARKS_MODEL
from services.client import get_async_client
from services.openrouter import _reasoning_body

log = logging.getLogger(__name__)

_CHECK_SIZE = 2000            # photos are scaled to this first, so the count below means the same for any photo
_PAPER_SHARE = 0.10           # the brightest tenth of a photo is taken to be the paper
_PAPER_LEVEL = 230            # each colour is scaled so the paper comes out this bright, whatever the light
_MAX_BOOST = 4.0              # a photo darker than this is mostly noise
# These lean towards reading too many pages. A false alarm costs one cheap AI read that
# then reports no marks, but a miss loses a supplier's mistake for good. Set from
# simulated pens and AI-edited photos: no real red-pen photo has been tried yet.
_RED_MARGIN = 25              # how much stronger red must be than both green and blue
_RED_PIXELS_NEEDED = 15
_BOX_PAD = 0.02               # the AI's box for a mark can be a little off
_RED_AT_MARK_NEEDED = 6       # in testing, real marks had 420 or more and invented ones 0
_SCAN_TIMEOUT_SECONDS = 120
_SCAN_MAX_AGE_SECONDS = 24 * 3600   # long enough for a DC extracted one day and saved the next
_MAX_SCANS = 20                     # scans hold photos in memory, and /extract has no login
_REPORT_RETRY_WAITS = (5, 30)

_TOOL = {
    "type": "function",
    "function": {
        "name": "report_pen_marks",
        "description": "Report every red pen mark on the delivery note.",
        "parameters": {
            "type": "object",
            "properties": {
                "marks": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "product_name": {"type": "string", "description": "Printed product name on that row. Empty if the mark is not on a product row."},
                            "column": {"type": "string", "enum": ["product", "pack", "batch", "expiry", "qty", "mrp", "rate", "discount", "value", "header", "other"]},
                            "mark_type": {"type": "string", "enum": ["circled", "struck_out", "overwritten", "handwritten_correction", "handwritten_note"]},
                            "printed_value": {"type": "string", "description": "The printed text the mark applies to."},
                            "handwritten_value": {"type": "string", "description": "Any handwritten replacement or note, exactly as written. Empty if none."},
                            "reason": {"type": "string", "description": "One short sentence on what was seen."},
                            "box": {"type": "array", "items": {"type": "integer"}, "description": "Where the red ink of this mark is: [ymin, xmin, ymax, xmax], each from 0 to 1000 across the image as it is, without turning it."},
                        },
                        "required": ["product_name", "column", "mark_type", "printed_value", "handwritten_value", "reason", "box"],
                    },
                }
            },
            "required": ["marks"],
        },
    },
}

_PROMPT = """This is a photo of a printed pharmacy delivery note. Staff use a normal pen for ticks, \
and a RED pen only when something is wrong. Your only job is to report the RED pen marks. \
Ignore every mark that is not red. The photo may be sideways.

Red that is printed or stamped, like a logo or a rubber stamp, is not a pen mark. Ignore it.

For each red pen mark, say what it is: circled (a red loop around a printed value, which means the \
supplier's printed value is wrong), struck_out (a red line through a value, word or row), \
overwritten, handwritten_correction (a value written in red that replaces a printed one), or \
handwritten_note. If a red circle and a red handwritten value belong to the same row, report them \
as one mark, with the printed value and the handwritten value together. A row can have a red mark \
in any column. If there is no red pen mark, return an empty list."""


def _paper_level(band: Image.Image) -> int:
    """How bright this colour gets in the brightest part of the photo."""
    counts = band.histogram()
    wanted = sum(counts) * _PAPER_SHARE
    seen = 0
    for level in range(255, 0, -1):
        seen += counts[level]
        if seen >= wanted:
            return level
    return 1


def _even_out_light(img: Image.Image) -> list[Image.Image]:
    """A dim shop or a yellow bulb changes how red ink looks. Scaling each colour so
    the paper comes out the same makes any photo read as if taken in good light."""
    bands = []
    for band in img.split():
        boost = min(_MAX_BOOST, _PAPER_LEVEL / _paper_level(band))
        bands.append(band.point([min(255, int(v * boost)) for v in range(256)]))
    return bands


def _redness(image_bytes: bytes) -> Image.Image:
    with Image.open(io.BytesIO(image_bytes)) as original:
        img = original.convert("RGB")
    img.thumbnail((_CHECK_SIZE, _CHECK_SIZE))
    red, green, blue = _even_out_light(img)
    return ImageChops.darker(ImageChops.subtract(red, green), ImageChops.subtract(red, blue))


def has_red_ink(image_bytes: bytes) -> bool:
    count = sum(_redness(image_bytes).histogram()[_RED_MARGIN:])
    log.info("Red check: %d red pixels (needs %d)", count, _RED_PIXELS_NEEDED)
    return count >= _RED_PIXELS_NEEDED


def _red_at(redness: Image.Image, box: object) -> bool:
    """Is there red ink where the AI says this mark is? On a page with a red stamp it
    has reported blue pen as red, and it stood by that when asked the ink's colour, so
    the photo decides. A mark with no usable box gets the benefit of the doubt."""
    if not (isinstance(box, list) and len(box) == 4 and all(isinstance(n, (int, float)) for n in box)):
        return True
    width, height = redness.size
    top, left, bottom, right = box
    area = (
        max(0, int((left / 1000 - _BOX_PAD) * width)),
        max(0, int((top / 1000 - _BOX_PAD) * height)),
        min(width, int((right / 1000 + _BOX_PAD) * width)),
        min(height, int((bottom / 1000 + _BOX_PAD) * height)),
    )
    if area[2] <= area[0] or area[3] <= area[1]:
        return True
    return sum(redness.crop(area).histogram()[_RED_MARGIN:]) >= _RED_AT_MARK_NEEDED


async def _read_page(image_bytes: bytes, mime: str) -> list[dict]:
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"
    response = await get_async_client().chat.completions.create(
        model=MARKS_MODEL,
        messages=[{"role": "user", "content": [
            {"type": "text", "text": _PROMPT},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}],
        tools=[_TOOL],
        tool_choice={"type": "function", "function": {"name": "report_pen_marks"}},
        extra_body=_reasoning_body(MARKS_MODEL),
        timeout=_SCAN_TIMEOUT_SECONDS,
    )
    marks = json.loads(response.choices[0].message.tool_calls[0].function.arguments).get("marks", [])
    marks = [m for m in marks if isinstance(m, dict)]
    if not marks:
        return []
    redness = await asyncio.to_thread(_redness, image_bytes)
    real = [m for m in marks if _red_at(redness, m.get("box"))]
    if len(real) < len(marks):
        log.info("Dropped %d mark(s) with no red ink at that spot", len(marks) - len(real))
    return real


async def _read_marks(pages: list[tuple[bytes, str]]) -> list[dict]:
    marks: list[dict] = []
    for image_bytes, mime in pages:
        try:
            marks += await _read_page(image_bytes, mime)
        except Exception as e:
            log.warning("Pen mark read failed for one page: %s", type(e).__name__)
    log.info("Pen mark read found %d mark(s)", len(marks))
    return marks


class _Scan:
    def __init__(self, pages: list[tuple[bytes, str]]):
        self.pages = pages
        self.started_at = time.time()
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> list[dict]:
        checks = await asyncio.gather(
            *[asyncio.to_thread(has_red_ink, data) for data, _mime in self.pages],
            return_exceptions=True,
        )
        self.pages = [page for page, is_red in zip(self.pages, checks) if is_red is True]
        return await _read_marks(self.pages) if self.pages else []


_scans: dict[str, _Scan] = {}
_reports: set[asyncio.Task] = set()   # keeps running reports from being garbage-collected


def _drop_old_scans() -> None:
    cutoff = time.time() - _SCAN_MAX_AGE_SECONDS
    for old_id in [k for k, scan in _scans.items() if scan.started_at < cutoff]:
        _scans.pop(old_id).task.cancel()
    while len(_scans) >= _MAX_SCANS:
        _scans.pop(next(iter(_scans))).task.cancel()


def start_scan(pages: list[tuple[bytes, str]]) -> str:
    """Starts the red check, and the AI read if there's red, in the background.
    Call this after extraction has finished, so it can't slow it down or compete
    with it for the OpenRouter rate limit. Returns the scan_id to hand back at
    save time, or "" if it couldn't start."""
    try:
        _drop_old_scans()
        scan_id = uuid.uuid4().hex
        _scans[scan_id] = _Scan(pages)
        return scan_id
    except Exception as e:
        log.warning("Pen mark scan could not start: %s", type(e).__name__)
        return ""


async def _report(scan_id: str, dc_number: str, supplier_name: str, reference_no: str) -> None:
    scan = _scans.pop(scan_id, None)
    if scan is None:
        log.info("No pen mark scan held for dc=%s, nothing to report", dc_number)
        return
    marks = await scan.task
    if not marks:
        return

    fields = {
        "dc_number": dc_number,
        "supplier_name": supplier_name,
        "reference_no": reference_no,
        "marks": json.dumps(marks),
    }
    files = [("photos", (f"page{i}.jpg", data, mime)) for i, (data, mime) in enumerate(scan.pages, 1)]

    for wait in (*_REPORT_RETRY_WAITS, None):
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{DC_PIPELINE_URL}/stage3/mistakes", data=fields, files=files)
            if resp.is_success:
                log.info("Reported %d supplier mistake(s) for dc=%s", len(marks), dc_number)
                return
            if resp.status_code < 500:
                log.warning("dc_pipeline refused mistakes for dc=%s: status=%s", dc_number, resp.status_code)
                return
        except httpx.HTTPError as e:
            log.warning("Could not reach dc_pipeline for dc=%s: %s", dc_number, type(e).__name__)
        if wait is not None:
            await asyncio.sleep(wait)
    log.warning("Gave up reporting supplier mistakes for dc=%s", dc_number)


async def _report_safely(*args: str) -> None:
    try:
        await _report(*args)
    except Exception as e:
        log.warning("Supplier mistake report failed: %s", type(e).__name__)


def report_later(scan_id: str, dc_number: str, supplier_name: str, reference_no: str) -> None:
    """Called after a successful CRM save. Returns straight away: the report
    waits for the scan if it's still running, and the save never waits for it."""
    if not scan_id:
        return
    try:
        task = asyncio.create_task(_report_safely(scan_id, dc_number, supplier_name, reference_no))
        _reports.add(task)
        task.add_done_callback(_reports.discard)
    except Exception as e:
        log.warning("Supplier mistake report could not start: %s", type(e).__name__)
