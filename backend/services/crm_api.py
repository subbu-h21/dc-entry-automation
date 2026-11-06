"""
All calls to the CRM's DC Inward API live here (see the provider's "DC Inward &
Purchase Entry API" guide). routes/crm.py builds the request; this module talks
to the CRM and turns its answers into something safe to show staff.

Three rules this file exists to enforce:

1. Raw CRM error text never leaves this module, not to the screen and not to
   the logs. The test server has returned an unhandled database error whose
   text included the server's own database login, so anything that isn't one
   of the CRM's known report messages or a recognised validation line is
   replaced with GENERIC_ERROR (see _safe_text and _validation_issues), and
   the logs only ever get a status and a tidy code (see _log_code). This app
   is on the public internet, so a pass-through here would publish it.
2. The client secret and token stay on this server. The browser only ever
   talks to this backend.
3. Saves never run in parallel (_save_lock). Two simultaneous saves of the same
   DC are what produced that unhandled error.
"""

import asyncio
import logging
import re
import time

import httpx

from config import (
    CRM_API_BASE_URL,
    CRM_BRANCH_IDS,
    CRM_CLIENT_ID,
    CRM_CLIENT_SECRET,
    CRM_DEFAULT_EMPLOYEE_ID,
)

log = logging.getLogger(__name__)

_TOKEN_PATH = "/integration/oauth/token"
_DC_PATH = "/integration/v1/dc-inward"
_SAVE_TIMEOUT_SECONDS = 30
_LOOKUP_TIMEOUT_SECONDS = 10
_TOKEN_MARGIN_SECONDS = 60     # renew this long before the CRM's expiry
_CONTEXT_TTL_SECONDS = 300
_CONTEXT_RETRY_SECONDS = 30   # after a failed refresh, don't retry sooner than this
_LOOKUP_CONCURRENCY = 5

# The CRM's answer when an employee can't be the X-Employee-Id on a branch.
# This is a setting on the CRM's employee record, nobody actually signs in.
_EMPLOYEE_REFUSED = {"BRANCH_NOT_ALLOWED", "EMPLOYEE_NO_LOGIN", "FORBIDDEN"}

GENERIC_ERROR = "The CRM couldn't process this."

# Anything that reads like a database, a server or a crash rather than a stock
# rule. The word "password" alone is fine: the CRM's own MRP_NEEDS_ADMIN message
# says it needs "an admin's password on the DC Inward screen".
_LEAK_RE = re.compile(
    r"sqlcmd|mssql|sql ?server|sqlclient|sqlexception|sqlstate|command failed|login failed|"
    r"exception|traceback|stack trace|econnrefused|"
    r"(?:password|passwd|pwd)\s*(?:=|:|is\b)|"
    r"(?:user id|uid|data source|initial catalog|server|database)\s*=|"
    r"/opt/|/tmp/|[a-z]:\\|\s-P\s|\s-U\s",
    re.I,
)
_CODE_RE = re.compile(r"^[A-Z][A-Z_]{2,39}$")
_LINE_VALIDATION_RE = re.compile(r"^lines\[(\d+)\]\.(\w+) ([^\n]{1,160})$")
_HEADER_VALIDATION_RE = re.compile(r"^[a-zA-Z]+ (?:is|must) [^\n]{1,160}$")

_FIELD_LABELS = {
    "productId": "Product",
    "batchNumber": "Batch",
    "expiry": "Expiry",
    "mrp": "MRP",
    "rate": "Rate",
    "quantity": "Qty",
    "freeQuantity": "Free",
    "discountPercent": "Disc%",
}


class CrmError(Exception):
    """A failure whose `message` is safe to show staff."""

    def __init__(self, message: str = GENERIC_ERROR):
        super().__init__(message)
        self.message = message


class CrmUnreachable(CrmError):
    """No clear answer from the CRM (timeout, connection failure, a 5xx, or a
    save still in progress). For a save this means it may or may not have gone
    through, which is why the caller keeps the same save key for the retry."""


class CrmRefused(CrmError):
    """The CRM clearly said no, but not in a form we can show row by row.
    Nothing was saved."""


def _safe_text(text: str) -> str:
    return GENERIC_ERROR if _LEAK_RE.search(text) else text


def _error_body(resp: httpx.Response) -> dict:
    try:
        body = resp.json()
    except ValueError:
        return {}
    err = body.get("error") if isinstance(body, dict) else None
    return err if isinstance(err, dict) else {}


def _log_code(resp: httpx.Response) -> str:
    """The CRM's error code for the logs, only when it looks like a code. Some
    refusals carry a sentence in that field instead."""
    code = str(_error_body(resp).get("code") or "")
    return code if _CODE_RE.match(code) else "-"


# ── Token ─────────────────────────────────────────────────────

_token = ""
_token_expires_at = 0.0
_token_lock = asyncio.Lock()


async def _get_token(force: bool = False) -> str:
    global _token, _token_expires_at
    async with _token_lock:
        if not force and _token and time.time() < _token_expires_at:
            return _token

        if not (CRM_API_BASE_URL and CRM_CLIENT_ID and CRM_CLIENT_SECRET):
            raise CrmError("The CRM API is not set up. Check CRM_API_BASE_URL, CRM_CLIENT_ID and CRM_CLIENT_SECRET in .env.")

        try:
            async with httpx.AsyncClient(timeout=_LOOKUP_TIMEOUT_SECONDS) as client:
                resp = await client.post(f"{CRM_API_BASE_URL}{_TOKEN_PATH}", json={
                    "grant_type": "client_credentials",
                    "client_id": CRM_CLIENT_ID,
                    "client_secret": CRM_CLIENT_SECRET,
                })
        except (httpx.HTTPError, httpx.InvalidURL) as e:
            log.warning("CRM token request failed: %s", type(e).__name__)
            raise CrmUnreachable("Couldn't reach the CRM. Try again.")

        if resp.status_code >= 500:
            log.warning("CRM token request got status=%s", resp.status_code)
            raise CrmUnreachable("Couldn't reach the CRM. Try again.")

        if resp.status_code != 200:
            log.error("CRM refused the token request: status=%s", resp.status_code)
            raise CrmError("The CRM refused our API login. Check CRM_CLIENT_ID and CRM_CLIENT_SECRET in .env.")

        try:
            body = resp.json()
            _token = body["access_token"]
            _token_expires_at = time.time() + int(body.get("expires_in", 900)) - _TOKEN_MARGIN_SECONDS
        except (ValueError, KeyError, TypeError):
            log.error("CRM token response was not in the expected shape")
            raise CrmError("The CRM's API login answer wasn't understood.")
        return _token


async def _request(
    method: str,
    path: str,
    branch_id: int,
    employee_id: int,
    *,
    json: dict | None = None,
    params: dict | None = None,
    idempotency_key: str | None = None,
) -> httpx.Response:
    timeout = _SAVE_TIMEOUT_SECONDS if method == "POST" else _LOOKUP_TIMEOUT_SECONDS
    for attempt in (1, 2):
        token = await _get_token(force=attempt == 2)
        headers = {
            "Authorization": f"Bearer {token}",
            "X-Branch-Id": str(branch_id),
            "X-Employee-Id": str(employee_id),
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.request(
                    method, f"{CRM_API_BASE_URL}{_DC_PATH}{path}",
                    headers=headers, json=json, params=params,
                )
        except httpx.HTTPError as e:
            log.warning("CRM request failed: %s %s (%s)", method, path or "/", type(e).__name__)
            raise CrmUnreachable("Couldn't reach the CRM. Try again.")

        if resp.status_code == 401 and attempt == 1:
            continue  # token expired early or was revoked: renew once
        return resp
    return resp


# ── Supplier and staff lists ──────────────────────────────────

class _Context:
    def __init__(self, suppliers: list[tuple[int, str]], employees: list[tuple[int, str]]):
        self.suppliers = _labelled(suppliers)
        self.employees = _labelled(employees)


def _labelled(items: list[tuple[int, str]]) -> dict[str, tuple[int, str]]:
    """{label: (id, real name)}. Staff pick by name, so two entries sharing a
    name (the CRM has one such supplier) get their ID added to stay distinct."""
    counts: dict[str, int] = {}
    for _id, name in items:
        counts[name.upper()] = counts.get(name.upper(), 0) + 1
    return {
        (f"{name} ({_id})" if counts[name.upper()] > 1 else name): (_id, name)
        for _id, name in items
    }


_context: _Context | None = None
_context_loaded_at = 0.0
_context_retry_at = 0.0
_context_lock = asyncio.Lock()


async def _get_context() -> _Context:
    global _context, _context_loaded_at, _context_retry_at
    async with _context_lock:
        now = time.time()
        if _context and now - _context_loaded_at < _CONTEXT_TTL_SECONDS:
            return _context
        if now < _context_retry_at:
            # The last refresh just failed. Everything that needs these lists
            # queues on this lock, so don't make each caller sit out a timeout.
            if _context:
                return _context
            raise CrmError("Couldn't load the supplier and staff lists from the CRM.")
        try:
            # Suppliers and staff are the same on every branch (checked on the
            # test server), so any branch and the default employee will do.
            branch_id = next(iter(CRM_BRANCH_IDS.values()))
            resp = await _request("GET", "/context", branch_id, CRM_DEFAULT_EMPLOYEE_ID)
            if resp.status_code != 200:
                log.error("CRM context failed: status=%s code=%s", resp.status_code, _log_code(resp))
                raise CrmError("Couldn't load the supplier and staff lists from the CRM.")
            try:
                data = resp.json()
                fresh = _Context(
                    [(s["supplierId"], s["supplierName"].strip()) for s in data.get("suppliers", [])],
                    [(e["employeeId"], e["employeeName"].strip()) for e in data.get("employees", [])],
                )
            except (ValueError, KeyError, TypeError, AttributeError):
                log.error("CRM context was not in the expected shape")
                raise CrmError("Couldn't load the supplier and staff lists from the CRM.")
            if not (fresh.suppliers and fresh.employees):
                log.error("CRM context came back empty")
                raise CrmError("Couldn't load the supplier and staff lists from the CRM.")
            _context, _context_loaded_at = fresh, time.time()
            log.info("CRM lists loaded: %d suppliers, %d staff", len(fresh.suppliers), len(fresh.employees))
            return _context
        except CrmError:
            _context_retry_at = time.time() + _CONTEXT_RETRY_SECONDS
            if _context:
                log.warning("CRM lists refresh failed, using the last good copy")
                return _context
            raise


async def supplier_names() -> list[str]:
    return sorted((await _get_context()).suppliers, key=str.upper)


async def staff_names() -> list[str]:
    return sorted((await _get_context()).employees, key=str.upper)


async def supplier_lookup(label: str) -> tuple[int, str] | None:
    return (await _get_context()).suppliers.get(label.strip())


async def employee_lookup(label: str) -> tuple[int, str] | None:
    return (await _get_context()).employees.get(label.strip())


# ── Products ──────────────────────────────────────────────────

AMBIGUOUS = -1   # more than one CRM product fits, so this row must not be guessed

_product_ids: dict[tuple[str, str], int] = {}


def _product_key(name: str) -> str:
    return re.sub(r"\s+", " ", str(name)).strip().upper()


def _pick_product(hits: list[dict], pack: str) -> int:
    """Picks from the CRM products with exactly this name. Several can share one
    name and differ only by pack (VEET HAIR REMOVER comes in 25GM and 60GM), and
    the wrong one is the wrong stock, so the pack decides and a tie is never
    guessed at. "10S" and "10 S" can be two separate products, so spaces only
    stop mattering when no pack matches as written."""
    if len(hits) == 1:
        return hits[0]["productId"]
    wanted = _product_key(pack)
    same = [h for h in hits if _product_key(h.get("packLabel") or "") == wanted]
    if not same:
        wanted = wanted.replace(" ", "")
        same = [h for h in hits if _product_key(h.get("packLabel") or "").replace(" ", "") == wanted]
    return same[0]["productId"] if len(same) == 1 else AMBIGUOUS


async def _find_product_id(name: str, pack: str, branch_id: int) -> int | None:
    key = _product_key(name)
    cache_key = (key, _product_key(pack))
    if cache_key in _product_ids:
        return _product_ids[cache_key]

    # The CRM treats [ as a search pattern, so S.V.SET[HMD] 23 finds nothing
    # as written. _ stands for any one character, and the name check below
    # still has to match exactly.
    resp = await _request(
        "GET", "/products/search", branch_id, CRM_DEFAULT_EMPLOYEE_ID, params={"search": name.replace("[", "_")},
    )
    if resp.status_code != 200:
        log.error("CRM product search failed: status=%s code=%s", resp.status_code, _log_code(resp))
        raise CrmError("Couldn't look up products in the CRM.")

    # Match on the exact name, never the first result: the right product isn't
    # always listed first, and a near-match here is a wrong medicine in stock.
    try:
        hits = [p for p in resp.json() if _product_key(p.get("productName", "")) == key]
        if not hits:
            return None
        product_id = _pick_product(hits, pack)
    except (ValueError, KeyError, TypeError, AttributeError):
        log.error("CRM product search answer was not in the expected shape")
        raise CrmError("Couldn't look up products in the CRM.")
    if product_id != AMBIGUOUS:
        _product_ids[cache_key] = product_id
    return product_id


async def find_product_ids(products: list[tuple[str, str]], branch_id: int) -> list[int | None]:
    """products is (name, pack) per row. Each answer is a product id, None if
    the CRM has no such name, or AMBIGUOUS."""
    sem = asyncio.Semaphore(_LOOKUP_CONCURRENCY)

    async def one(name: str, pack: str) -> int | None:
        async with sem:
            return await _find_product_id(name, pack, branch_id)

    return list(await asyncio.gather(*[one(n, p) for n, p in products]))


# ── Check and save ────────────────────────────────────────────

# (branch, employee) pairs the CRM refused as X-Employee-Id, so that Save goes
# straight to the fallback instead of spending its save key on a refusal.
_refused_employees: set[tuple[int, int]] = set()
_save_lock = asyncio.Lock()


async def _post_dc(
    path: str, body: dict, branch_id: int, employee_id: int, key: str | None = None,
) -> httpx.Response:
    """Sends the Checked By person as Created By when the CRM allows it on this
    branch, otherwise CRM_DEFAULT_EMPLOYEE_ID. Checked By on the DC itself is
    unaffected: it goes in the body and accepts any employee."""
    entered_by = CRM_DEFAULT_EMPLOYEE_ID if (branch_id, employee_id) in _refused_employees else employee_id
    resp = await _request("POST", path, branch_id, entered_by, json=body, idempotency_key=key)

    if (
        resp.status_code == 403
        and _error_body(resp).get("code") in _EMPLOYEE_REFUSED
        and entered_by != CRM_DEFAULT_EMPLOYEE_ID
    ):
        log.info("Employee %s can't enter on branch %s, using the default", entered_by, branch_id)
        _refused_employees.add((branch_id, entered_by))
        resp = await _request("POST", path, branch_id, CRM_DEFAULT_EMPLOYEE_ID, json=body, idempotency_key=key)
    return resp


def _issue(item: dict, line_rows: list[int]) -> dict:
    line = item.get("line")
    row = line_rows[line - 1] if isinstance(line, int) and 1 <= line <= len(line_rows) else None
    return {
        "code": str(item.get("code", "")),
        "row": row,
        "product": str(item.get("productName") or ""),
        "message": _safe_text(str(item.get("message") or item.get("code") or GENERIC_ERROR)),
    }


def _parse_report(report: dict, line_rows: list[int]) -> dict:
    preview = report.get("preview")
    return {
        "errors": [_issue(x, line_rows) for x in report.get("errors", [])],
        "questions": [_issue(x, line_rows) for x in report.get("confirmations", [])],
        "net_amount": preview.get("netAmount") if isinstance(preview, dict) else None,
    }


def _validation_issues(lines: object, line_rows: list[int]) -> list[dict]:
    """Only text in the CRM's known validation shapes gets through. The
    unhandled database error also arrives with code VALIDATION_ERROR, so the
    code alone proves nothing."""
    issues = []
    for text in lines if isinstance(lines, list) else []:
        text = str(text)
        match = _LINE_VALIDATION_RE.match(text)
        if match and not _LEAK_RE.search(text):
            index, field, rest = int(match.group(1)), match.group(2), match.group(3)
            row = line_rows[index] if index < len(line_rows) else None
            message = f"{_FIELD_LABELS.get(field, field)} {rest}"
        elif _HEADER_VALIDATION_RE.match(text) and not _LEAK_RE.search(text):
            row, message = None, text
        else:
            row, message = None, GENERIC_ERROR
        issues.append({"code": "VALIDATION_ERROR", "row": row, "product": "", "message": message})
    return issues


def _report_from_refusal(resp: httpx.Response, line_rows: list[int]) -> dict:
    err = _error_body(resp)
    details = err.get("details") if isinstance(err.get("details"), dict) else {}

    if "canSave" in details:
        return _parse_report(details, line_rows)

    if resp.status_code == 400 and err.get("code") == "VALIDATION_ERROR":
        issues = _validation_issues(details.get("errors"), line_rows)
        if issues:
            return {"errors": issues, "questions": [], "net_amount": None}

    log.error("CRM refused the DC: status=%s code=%s", resp.status_code, _log_code(resp))
    raise CrmRefused()


async def check_dc(body: dict, branch_id: int, employee_id: int, line_rows: list[int]) -> dict:
    """Asks the CRM to check the DC. Saves nothing."""
    resp = await _post_dc("/check", body, branch_id, employee_id)
    if resp.status_code == 200:
        try:
            return _parse_report(resp.json(), line_rows)
        except (ValueError, TypeError, AttributeError):
            log.error("CRM check answer was not in the expected shape")
            raise CrmError()
    return _report_from_refusal(resp, line_rows)


async def save_dc(body: dict, branch_id: int, employee_id: int, line_rows: list[int], key: str) -> dict:
    """Saves the DC: stock goes up immediately and it can't be undone from here.
    Returns {"saved": True, "ref_no": ...} or {"saved": False, "report": ...}."""
    async with _save_lock:
        resp = await _post_dc("", body, branch_id, employee_id, key=key)

    if resp.status_code == 201:
        # Stock is already up at this point, so an answer we can't read must
        # still count as saved.
        try:
            data = resp.json()
            document = data.get("document")
            document = document if isinstance(document, dict) else {}
            ref_no = data.get("refNo") or document.get("dcUid") or ""
        except (ValueError, AttributeError):
            log.error("CRM saved the DC but its answer was not in the expected shape")
            return {"saved": True, "ref_no": ""}
        log.info("DC saved to CRM: dc=%s ref=%s", document.get("dcNumber"), ref_no)
        return {"saved": True, "ref_no": ref_no}

    if resp.status_code == 409:
        raise CrmUnreachable("The CRM is still saving this. Wait a moment, then click Save again.")

    # A 5xx says nothing about whether the save went through: a gateway can fail
    # after the CRM has committed. Treat it as unknown, so the same key is reused.
    if resp.status_code >= 500:
        log.error("CRM save got status=%s code=%s", resp.status_code, _log_code(resp))
        raise CrmUnreachable()

    return {"saved": False, "report": _report_from_refusal(resp, line_rows)}
