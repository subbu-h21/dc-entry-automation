import asyncio
import logging
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from playwright.async_api import async_playwright

router = APIRouter()
log = logging.getLogger(__name__)

_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCREENSHOTS_DIR = os.path.join(_BACKEND_DIR, "screenshots")


def _cleanup_old_screenshots():
    if not os.path.isdir(SCREENSHOTS_DIR):
        return
    cutoff = time.time() - (5 * 3600)
    for name in os.listdir(SCREENSHOTS_DIR):
        folder = os.path.join(SCREENSHOTS_DIR, name)
        if os.path.isdir(folder) and os.path.getmtime(folder) < cutoff:
            shutil.rmtree(folder, ignore_errors=True)
            log.info("Cleaned up old screenshot folder: %s", name)


_cleanup_old_screenshots()

_BRANCH_CREDENTIALS = {
    "HOSPET ROAD":   ("9448188002", "Q"),
    "SHIVAJI CHOWK": ("ghegde",    "q"),
}


class _Session:
    def __init__(self):
        self.alive = threading.Event()
        self.kill  = threading.Event()
        self.save  = threading.Event()


_sessions: dict[str, _Session] = {}


class ProductEntry(BaseModel):
    matched_product: str = ""
    batch_number: str = ""
    expiry: str = ""
    old_mrp: float = 0
    mrp: float = 0
    rate: float = 0
    quantity: float = 0
    free: float = 0
    disc_percent: float = 0


class DCDetails(BaseModel):
    tab_id: str = ""
    dc_number: str = ""
    dc_date: str = ""       # YYYY-MM-DD from frontend date input
    supplier: str = ""
    checked_by: str = ""
    branch: str = "HOSPET ROAD"
    products: list[ProductEntry] = []


# =========================================================
# LOGIN
# =========================================================

async def login(page, branch: str = "HOSPET ROAD"):
    username, password = _BRANCH_CREDENTIALS.get(branch, _BRANCH_CREDENTIALS["HOSPET ROAD"])
    await page.goto("https://shubhadahealth.com:7007/")
    await page.locator("#mat-input-0").fill(username)
    await page.locator("#mat-input-1").fill(password)
    await page.keyboard.press("Enter")
    await page.wait_for_load_state("networkidle")


# =========================================================
# OPEN SIDEBAR → PROCUREMENT → DC INWARD
# =========================================================

async def open_sidebar(page):
    await page.locator("mat-icon", has_text="menu").click()


async def open_dc_inward(page):
    await page.locator(".menuitem", has_text="Procurement").click()
    await page.locator(".menuitem", has_text="DC Inward").click()
    await page.wait_for_timeout(1000)


# =========================================================
# FILL HEADER FIELDS
# =========================================================

async def fill_dc_number(page, value: str):
    if not value:
        return
    await page.fill("#dc_no_id", value)
    await page.wait_for_timeout(200)
    log.info("Filled DC Number: %s", value)


async def fill_dc_date(page, value: str):
    """
    DC Date input is readonly (Angular Material datepicker).
    Remove readonly via JS, type date as DD/MM/YYYY, press Tab to commit.
    """
    if not value:
        return
    try:
        dt = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        log.warning("Invalid dc_date format: %r — expected YYYY-MM-DD", value)
        return

    formatted = dt.strftime("%m/%d/%Y")

    # Angular readonly datepicker — unlock and type MM/DD/YYYY, press Tab to commit.
    await page.evaluate("() => document.querySelector('#mat-input-6').removeAttribute('readonly')")
    await page.click("#mat-input-6")
    await page.keyboard.type(formatted)
    await page.keyboard.press("Tab")
    await page.wait_for_timeout(300)
    log.info("Filled DC Date: %s → %s", value, formatted)


async def fill_supplier(page, value: str):
    """
    Supplier is a mat-autocomplete. Type the name, wait for dropdown, click match.
    """
    if not value:
        return
    await page.click("#billsupp")
    await page.fill("#billsupp", value)
    await page.wait_for_timeout(700)

    try:
        option = page.locator("mat-option", has_text=value).first
        await option.wait_for(state="visible", timeout=3000)
        await option.click()
        log.info("Selected supplier: %s", value)
    except Exception:
        # No exact match — take the first visible option
        try:
            await page.locator("mat-option").first.click()
            log.info("Selected first autocomplete option for supplier: %s", value)
        except Exception:
            await page.keyboard.press("Escape")
            log.warning("Could not select supplier: %s", value)

    await page.wait_for_timeout(300)


async def fill_checked_by(page, value: str):
    """
    Checked By is a mat-autocomplete. Type name, pick first match.
    """
    if not value:
        return
    await page.click("#mat-input-10")
    await page.fill("#mat-input-10", value)
    await page.wait_for_timeout(700)

    try:
        option = page.locator("mat-option", has_text=value).first
        await option.wait_for(state="visible", timeout=3000)
        await option.click()
        log.info("Selected checked_by: %s", value)
    except Exception:
        try:
            await page.locator("mat-option").first.click()
            log.info("Selected first autocomplete option for checked_by: %s", value)
        except Exception:
            await page.keyboard.press("Escape")
            log.warning("Could not select checked_by: %s", value)

    await page.wait_for_timeout(300)


async def fill_dc_details(page, details: DCDetails):
    await fill_dc_number(page, details.dc_number)
    await fill_dc_date(page, details.dc_date)
    await fill_supplier(page, details.supplier)
    await fill_checked_by(page, details.checked_by)


# =========================================================
# PRODUCT ROWS
# =========================================================

def _fmt(v: float) -> str:
    return str(int(v)) if v == int(v) else str(v)


def _fmt_expiry(expiry: str) -> str:
    """Convert any expiry format (06-26, 6/26, 06/2026) to MMYY digits only.
    The web form already has '-' pre-typed, so we just send the 4 digits."""
    if not expiry:
        return ""
    parts = re.split(r"[-/]", expiry.strip())
    if len(parts) == 2:
        month = parts[0].strip().zfill(2)
        year  = parts[1].strip()[-2:]   # last 2 digits handles both YY and YYYY
        return month + year
    digits = re.sub(r"\D", "", expiry)
    if len(digits) == 3:
        digits = "0" + digits           # e.g. "927" → "0927"
    return digits[:4]


async def _fill_product_name(page, row, name: str):
    """Type into the autocomplete, wait for dropdown, select first hit."""
    name_input = row.locator('input[name="prdname"]')
    await name_input.click()
    await page.wait_for_timeout(150)
    await page.keyboard.type(name, delay=20)

    try:
        await page.locator("mat-option").first.wait_for(state="visible", timeout=6000)
        await page.wait_for_timeout(200)
        await page.keyboard.press("ArrowDown")
        await page.wait_for_timeout(150)
        await page.keyboard.press("Enter")
    except Exception:
        log.warning("Autocomplete did not appear for %r — pressing Enter anyway", name)
        await page.keyboard.press("Enter")

    # Pack + Factor load server-side; wait for cursor to actually land in Batch
    await page.wait_for_function(
        "() => document.activeElement?.name === 'btch'",
        timeout=10000,
    )
    await page.wait_for_timeout(200)


async def _fill_row(page, row, product: ProductEntry):
    await _fill_product_name(page, row, product.matched_product)

    async def fill_and_advance(field_name: str, value: str) -> None:
        inp = row.locator(f'input[name="{field_name}"]')
        await inp.click()
        await page.wait_for_timeout(120)
        if value:
            await page.keyboard.type(value, delay=20)
        await page.wait_for_timeout(150)
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(150)

    # Tab-stop order: btch → expry → mrpp (Old MRP) → rtt (Rate) → qty → frqty → disper
    # MRP column has no input — auto-calculated, skip it.
    await fill_and_advance("btch",  product.batch_number)
    await fill_and_advance("expry", _fmt_expiry(product.expiry))
    await fill_and_advance("mrpp",  _fmt(product.mrp)   if product.mrp  > 0 else "")
    await fill_and_advance("rtt",   _fmt(product.rate)  if product.rate > 0 else "")
    await fill_and_advance("qty",   _fmt(product.quantity))
    await fill_and_advance("frqty", _fmt(product.free)  if product.free > 0 else "")

    # disper — wait longer before Enter so Angular can finish discamt recalculation
    disc_val = _fmt(product.disc_percent) if product.disc_percent > 0 else "0"
    await row.locator('input[name="disper"]').click()
    await page.wait_for_timeout(120)
    await page.keyboard.type(disc_val, delay=20)
    await page.wait_for_timeout(500)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(300)

    log.info("Filled row: %s | batch=%s | qty=%s", product.matched_product, product.batch_number, product.quantity)


async def fill_products(page, products: list[ProductEntry]):
    if not products:
        return
    for i, product in enumerate(products):
        if i > 0:
            # Wait for the new row to appear in the DOM — more reliable than waiting
            # for prdname focus, since _fill_product_name clicks prdname explicitly anyway.
            await page.wait_for_function(
                f"() => document.querySelectorAll('#tab_id tr.ng-star-inserted').length >= {i + 1}",
                timeout=10000,
            )
        row = page.locator("#tab_id tr.ng-star-inserted").nth(i)
        await _fill_row(page, row, product)


# =========================================================
# MAIN COROUTINE
# =========================================================

async def _browser_coroutine(session_id: str, details: DCDetails):
    session = _sessions[session_id]

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        page = await browser.new_page()

        await login(page, details.branch)
        await open_sidebar(page)
        await open_dc_inward(page)
        await fill_dc_details(page, details)
        await fill_products(page, details.products)

        screenshot_bytes = await page.screenshot()
        screenshot_path = os.path.join(SCREENSHOTS_DIR, session_id, "screenshot.png")
        os.makedirs(os.path.dirname(screenshot_path), exist_ok=True)
        with open(screenshot_path, "wb") as f:
            f.write(screenshot_bytes)
        log.info("Screenshot saved to disk for session %s", session_id)

        while browser.is_connected():
            if session.kill.is_set():
                await browser.close()
                break
            if session.save.is_set():
                session.save.clear()
                try:
                    await page.locator('button.buttoncolor', has_text='Save').first.click()
                    log.info("Clicked Save for session %s", session_id)
                except Exception:
                    log.exception("Failed to click Save for session %s", session_id)
            await asyncio.sleep(0.5)

    session.alive.clear()


def _browser_worker(session_id: str, details: DCDetails):
    session = _sessions[session_id]
    session.alive.set()
    loop = asyncio.ProactorEventLoop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_browser_coroutine(session_id, details))
    except Exception:
        log.exception("Browser worker crashed for session %s", session_id)
    finally:
        loop.close()
        session.alive.clear()


@router.get("/screenshot/{tab_id}")
def get_screenshot(tab_id: str):
    path = os.path.join(SCREENSHOTS_DIR, tab_id, "screenshot.png")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No screenshot yet")
    return FileResponse(path, media_type="image/png")


@router.post("/save-dc/{session_id}")
def save_dc(session_id: str):
    session = _sessions.get(session_id)
    if not session or not session.alive.is_set():
        raise HTTPException(status_code=400, detail="No active browser session")
    session.save.set()
    return {"status": "saving"}


@router.post("/launch-browser")
def launch_browser(details: DCDetails = DCDetails()):
    tab_id = details.tab_id or str(uuid.uuid4())
    _sessions[tab_id] = _Session()
    t = threading.Thread(target=_browser_worker, args=(tab_id, details), daemon=True)
    t.start()
    log.info("Launched browser session for tab %s", tab_id)
    return {"status": "launched"}
