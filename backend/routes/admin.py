import csv
import logging
import os
import shutil
import tempfile
import threading

import config
from config import ADMIN_PIN, PRODUCT_LIST_PATH, PRODUCT_LIST_SHEET, STAFF_CSV_PATH
from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from openpyxl.utils.exceptions import InvalidFileException
from pydantic import BaseModel

from services.matcher_instance import replace_catalog_file
from services.product_matcher import ProductMatcher

log = logging.getLogger(__name__)

MAX_UPLOAD_SIZE = 20 * 1024 * 1024  # a full catalog, not a photo — mirrors inbox.py's MAX_SIZE pattern but larger
MAX_NAME_LENGTH = 100

# Serializes staff-CSV and product-catalog writes. FastAPI runs sync `def`
# routes in a thread pool, so two requests CAN genuinely interleave — most
# realistically a double-click firing two "Add" calls before the button
# disables. Without this, a classic read-modify-write lost-update is possible:
# both requests read the same starting list, each appends its own name, and
# whichever writes last silently erases the other's addition. One coarse lock
# for all admin mutations is cheap and sufficient — this is a low-traffic,
# single-operator admin page, not a concurrent-write-heavy system.
_write_lock = threading.Lock()


def _require_admin_pin(x_admin_pin: str = Header(default="")) -> None:
    if not ADMIN_PIN or x_admin_pin.strip() != ADMIN_PIN:
        raise HTTPException(status_code=401, detail="Invalid or missing admin PIN")


# PIN enforced once, at router level, so it covers every route below —
# including /admin/verify-pin itself. One auth mechanism, not a separate
# frontend-only check plus a differently-implemented "real" one.
router = APIRouter(prefix="/admin", dependencies=[Depends(_require_admin_pin)])


@router.post("/verify-pin")
def verify_pin():
    return {"ok": True}


# ── Staff roster ──────────────────────────────────────────────

class AddStaffRequest(BaseModel):
    name: str


def _write_staff_csv(names: list[str]) -> None:
    with open(STAFF_CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Staff Name"])
        for n in sorted(names, key=str.upper):
            writer.writerow([n])


@router.post("/staff")
def add_staff(body: AddStaffRequest):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    if len(name) > MAX_NAME_LENGTH:
        raise HTTPException(status_code=400, detail=f"Name is too long (max {MAX_NAME_LENGTH} characters)")

    with _write_lock:
        existing = config.STAFF_NAMES
        if any(n.upper() == name.upper() for n in existing):
            raise HTTPException(status_code=409, detail=f'"{name}" is already in the staff list')
        _write_staff_csv(existing + [name])
        updated = config.reload_staff()

    log.info("Admin: added staff %r (%d total)", name, len(updated))
    return {"staff": updated}


@router.delete("/staff/{name}")
def remove_staff(name: str):
    with _write_lock:
        existing = config.STAFF_NAMES
        remaining = [n for n in existing if n.upper() != name.upper()]
        if len(remaining) == len(existing):
            raise HTTPException(status_code=404, detail=f'"{name}" not found in the staff list')
        _write_staff_csv(remaining)
        updated = config.reload_staff()

    log.info("Admin: removed staff %r (%d remaining)", name, len(updated))
    return {"staff": updated}


# ── Product catalog ───────────────────────────────────────────

@router.post("/product-list")
async def upload_product_list(file: UploadFile = File(...)):
    original_name = file.filename or "upload.xlsx"
    ext = os.path.splitext(original_name)[1].lower()
    if ext != ".xlsx":
        raise HTTPException(status_code=400, detail="Only .xlsx files are accepted (PDF and legacy .xls are not supported yet).")

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(data) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Maximum size is 20 MB.")

    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".xlsx")
    os.close(tmp_fd)
    try:
        with open(tmp_path, "wb") as f:
            f.write(data)

        # Validate against a throwaway ProductMatcher BEFORE touching the live
        # catalog file — a bad upload must never be able to brick matching for
        # everyone else while the file is being figured out.
        try:
            candidate = ProductMatcher(tmp_path, sheet=PRODUCT_LIST_SHEET)
        except KeyError:
            raise HTTPException(status_code=400, detail=f'Sheet "{PRODUCT_LIST_SHEET}" not found in the uploaded file.')
        except ValueError:
            raise HTTPException(status_code=400, detail='Uploaded file is missing a "PRODUCT" column header on its first row.')
        except InvalidFileException:
            raise HTTPException(status_code=400, detail="Uploaded file is not a valid .xlsx workbook.")
        except Exception as e:
            log.warning("Product-list upload validation failed: %s", e)
            raise HTTPException(status_code=400, detail=f"Could not read uploaded file: {e}")

        family_count = len(candidate.family)
        product_count = sum(len(v) for v in candidate.family.values())
        if product_count == 0:
            raise HTTPException(status_code=400, detail="Uploaded file has a PRODUCT column but no product rows.")

        with _write_lock:
            backup_path = os.path.join(os.path.dirname(PRODUCT_LIST_PATH) or ".", "Product_List.backup.xlsx")
            made_backup = False
            try:
                if os.path.exists(PRODUCT_LIST_PATH):
                    shutil.copy2(PRODUCT_LIST_PATH, backup_path)
                    made_backup = True

                # replace_catalog_file does the file swap AND the rebuild
                # under matcher_instance.py's own lock — see its docstring
                # for why the swap can't safely happen outside that lock on
                # Windows (a plain os.replace() here, unsynchronized with
                # get_matcher()'s build path, failed under real concurrent
                # search traffic during development: WinError 5, because a
                # build in progress had the destination open for reading
                # without delete-share access).
                replace_catalog_file(tmp_path)
            except Exception as e:
                log.error("Failed to activate uploaded catalog: %s", e)
                if made_backup:
                    try:
                        replace_catalog_file(backup_path)
                        raise HTTPException(
                            status_code=500,
                            detail=f"Upload was valid but failed to activate; restored the previous catalog. ({e})",
                        )
                    except HTTPException:
                        raise
                    except Exception as rollback_err:
                        log.critical("Rollback ALSO failed after a failed catalog activation: %s", rollback_err)
                        raise HTTPException(
                            status_code=500,
                            detail=(
                                "Upload failed to activate, and restoring the previous catalog also failed. "
                                f"The catalog file may be in a bad state and needs manual attention. ({e} / {rollback_err})"
                            ),
                        )
                else:
                    raise HTTPException(
                        status_code=500,
                        detail=f"Upload was valid but failed to activate; no prior catalog existed to restore. ({e})",
                    )

        log.info(
            "Admin: replaced product catalog with %r — %d families / %d products",
            original_name, family_count, product_count,
        )
        return {"ok": True, "filename": original_name, "families": family_count, "products": product_count}
    finally:
        # Best-effort cleanup only — must never override the response we've
        # already decided on. On Windows this can fail with PermissionError:
        # when ProductMatcher(...) raises partway through construction (bad
        # sheet/column), the openpyxl read_only workbook it opened is never
        # explicitly closed (its own wb.close() only runs on the success
        # path), so the file handle can still be open here. Left-over temp
        # files are harmless (randomly named, OS temp dir is cleaned
        # periodically) — a failed cleanup must not turn a clean 400 into a
        # crashed 500, which is exactly what happened before this try/except
        # was added (confirmed live).
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError as e:
            log.warning("Could not remove temp upload file %s: %s", tmp_path, e)
