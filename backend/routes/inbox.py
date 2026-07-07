import io
import logging
import os
import uuid
from datetime import datetime

import httpx
from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image

from config import DC_PIPELINE_URL

router = APIRouter()
log = logging.getLogger(__name__)

_backend = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INBOX_DIR = os.path.join(_backend, "inbox")

ALLOWED_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"}
MAX_SIZE = 10 * 1024 * 1024

_EXT_MAP = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

# Photo types pulled in from dc_pipeline's DC records. Pipeline-imported files
# are saved with a "{type}_" filename prefix; _infer_photo_type reads it back.
_PIPELINE_PHOTO_TYPES = {"invoice", "corrected", "package"}


def _infer_photo_type(filename: str) -> str:
    for photo_type in _PIPELINE_PHOTO_TYPES:
        if filename.startswith(f"{photo_type}_"):
            return photo_type
    return "invoice"


def _find_file(image_id: str) -> str | None:
    if not os.path.isdir(INBOX_DIR):
        return None
    for name in os.listdir(INBOX_DIR):
        stem, _ = os.path.splitext(name)
        if stem == image_id:
            path = os.path.join(INBOX_DIR, name)
            if os.path.isfile(path):
                return path
    return None


@router.post("/inbox/upload")
async def upload_to_inbox(image: UploadFile = File(...)):
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f'Invalid file type "{image.content_type}". Allowed: JPEG, PNG, WebP, GIF.',
        )

    data = await image.read()
    if len(data) > MAX_SIZE:
        raise HTTPException(status_code=400, detail="File too large. Maximum size is 10 MB.")

    os.makedirs(INBOX_DIR, exist_ok=True)

    image_id = str(uuid.uuid4())
    ext = _EXT_MAP.get(image.content_type, ".jpg")
    filename = f"{image_id}{ext}"
    path = os.path.join(INBOX_DIR, filename)

    with open(path, "wb") as f:
        f.write(data)

    uploaded_at = datetime.utcfromtimestamp(os.path.getmtime(path)).isoformat() + "Z"
    log.info("Inbox upload: %s (%d bytes)", filename, len(data))
    return {"id": image_id, "filename": filename, "uploaded_at": uploaded_at}


async def _fetch_pipeline_json(client: httpx.AsyncClient, path: str, params: dict | None = None) -> dict:
    try:
        resp = await client.get(f"{DC_PIPELINE_URL}{path}", params=params)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502,
            detail=f"DC Pipeline server not reachable at {DC_PIPELINE_URL} — is it running? ({e})",
        )
    return resp.json()


@router.get("/inbox/pipeline-suppliers")
async def pipeline_suppliers():
    async with httpx.AsyncClient(timeout=10) as client:
        return await _fetch_pipeline_json(client, "/suppliers")


@router.post("/inbox/import-from-pipeline")
async def import_from_pipeline(
    dc_number: str = Query(...),
    supplier_id: int = Query(...),
):
    async with httpx.AsyncClient(timeout=15) as client:
        data = await _fetch_pipeline_json(
            client, "/stage2/find", params={"dc_number": dc_number, "supplier_id": supplier_id},
        )

        if not data.get("exists"):
            raise HTTPException(
                status_code=404,
                detail=f"No DC found in pipeline for DC {dc_number} / supplier {supplier_id}",
            )

        photos = [p for p in data.get("photos", []) if p.get("photo_type") in _PIPELINE_PHOTO_TYPES]

        os.makedirs(INBOX_DIR, exist_ok=True)
        imported = []
        for photo in photos:
            try:
                img_resp = await client.get(f"{DC_PIPELINE_URL}/photos/{photo['id']}")
                img_resp.raise_for_status()
            except httpx.HTTPError:
                log.warning("Skipping pipeline photo %s (fetch failed)", photo.get("id"))
                continue

            content_type = img_resp.headers.get("content-type", "image/jpeg")
            ext = _EXT_MAP.get(content_type, ".jpg")
            image_id = str(uuid.uuid4())
            stem = f"{photo['photo_type']}_{image_id}"
            filename = f"{stem}{ext}"
            path = os.path.join(INBOX_DIR, filename)
            with open(path, "wb") as f:
                f.write(img_resp.content)

            imported.append({
                "id": stem,
                "filename": filename,
                "photo_type": photo["photo_type"],
            })

    log.info(
        "Imported %d/%d pipeline photo(s) for dc=%s supplier=%d",
        len(imported), len(photos), dc_number, supplier_id,
    )
    return {"imported": len(imported), "items": imported}


@router.get("/inbox")
def list_inbox():
    if not os.path.isdir(INBOX_DIR):
        return []
    items = []
    for name in os.listdir(INBOX_DIR):
        path = os.path.join(INBOX_DIR, name)
        if not os.path.isfile(path):
            continue
        stem, _ = os.path.splitext(name)
        uploaded_at = datetime.utcfromtimestamp(os.path.getmtime(path)).isoformat() + "Z"
        items.append({
            "id": stem,
            "filename": name,
            "uploaded_at": uploaded_at,
            "thumbnail_url": f"/inbox/thumb/{stem}",
            "photo_type": _infer_photo_type(name),
        })
    items.sort(key=lambda x: x["uploaded_at"], reverse=True)
    return items


@router.get("/inbox/image/{image_id}")
def get_inbox_image(image_id: str):
    path = _find_file(image_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image not found.")
    return FileResponse(path)


@router.get("/inbox/thumb/{image_id}")
def get_inbox_thumb(image_id: str):
    path = _find_file(image_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image not found.")

    with Image.open(path) as img:
        img = img.convert("RGB")
        max_w = 400
        if img.width > max_w:
            ratio = max_w / img.width
            new_h = int(img.height * ratio)
            img = img.resize((max_w, new_h), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80)
        return Response(content=buf.getvalue(), media_type="image/jpeg")


@router.delete("/inbox/{image_id}")
def delete_inbox_image(image_id: str):
    path = _find_file(image_id)
    if not path:
        raise HTTPException(status_code=404, detail="Image not found.")
    os.remove(path)
    log.info("Inbox deleted: %s", image_id)
    return {"deleted": image_id}
