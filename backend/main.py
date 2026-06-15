import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)

from config import ALLOWED_ORIGINS, PORT
from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes.extract import router as extract_router
from routes.browser import router as browser_router
from routes.voice import router as voice_router
from routes.products import router as products_router
from routes.inbox import router as inbox_router

app = FastAPI(title="Pharmacy Bill Extractor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extract_router)
app.include_router(browser_router)
app.include_router(voice_router)
app.include_router(products_router)
app.include_router(inbox_router)


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
