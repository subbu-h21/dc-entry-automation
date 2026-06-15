import io
import logging
import os
import uuid
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from PIL import Image

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
