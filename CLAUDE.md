# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

The repo root only contains `dc-entry-automation/` — that's the whole project. Everything below is relative to that directory.

## Commands

### First-time setup
```
setup.bat
```
Creates `backend/venv`, installs `backend/requirements.txt`, installs the Playwright Chromium browser, installs `frontend/` npm deps, and copies `backend/.env.example` → `backend/.env`. After running it, fill in `backend/.env` (`OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, `PRODUCT_LIST_PATH`).

### Day-to-day development
Run backend and frontend separately so the frontend hot-reloads:
```
cd backend && venv\Scripts\activate && python main.py     # API on :3001 (PORT in .env)
cd frontend && npm run dev                                # Vite dev server on :5173, proxies /extract, /launch-browser, /voice, /products, /suppliers, /screenshot, /save-dc, /inbox to :3001 (see vite.config.ts)
```
Use `http://localhost:5173` while developing — it has hot reload and the API proxy.

### Build / typecheck frontend
```
cd frontend && npm run build     # tsc (typecheck) && vite build → frontend/dist
cd frontend && npm run preview
```
There is no separate lint script and no ESLint/Prettier config — `npm run build`'s `tsc` step (strict mode, `noUnusedLocals`/`noUnusedParameters` on) is the only static check. There is no Python linter/formatter configured either.

### "Production" launch
```
start.bat
```
This is **not** the dev workflow above — it builds the frontend (`npm run build`), then starts only the backend (`python main.py`), which serves the API *and* the built SPA from `frontend/dist` via the catch-all route in `main.py`, on port 3001 (not 5173). It also starts `tunnel.py`, which opens a Cloudflare quick tunnel to `localhost:3001` and prints a QR code — this is how the phone-camera "inbox" flow (see below) reaches the backend from outside localhost.

### Tests
There is no test suite in this repo (no test files, no test runner configured) — verify changes by running the app end-to-end.

## Architecture

Two-part app under `dc-entry-automation/`: a FastAPI backend and a React/Vite/TS frontend, joined either by the Vite proxy (dev) or by FastAPI serving the built SPA directly (prod, see `main.py`'s catch-all `serve_spa` route).

### Request flow: image → filled DC form

1. **Extraction** (`routes/extract.py` → `services/openrouter.py`): the uploaded invoice image (plus an optional second "product packaging" photo for disambiguation) is sent to a Gemini model via OpenRouter using forced tool-calling (`EXTRACTION_TOOL`) so the model returns structured JSON (`dc_number`, `dc_date`, `supplier_name`, `products[]`) instead of free text. The prompt encodes pharmacy-invoice-specific rules (e.g. the `"5+1"` free-qty notation, stripping MFR/HSN code columns from the product name) that later post-processing re-enforces as a fallback (`_fix_free_qty`, `_fix_expiry`, `_fix_batch` in `extract.py`).
2. **Product matching** (`services/product_matcher.py`, singleton in `services/matcher_instance.py`): a two-stage fuzzy match against the pharmacy's own catalog (`Product_List.xlsx`, sheet `data`, columns `PRODUCT`/`MANUFACTURER`/`PACK`, path from `PRODUCT_LIST_PATH`).
   - Stage 1 narrows ~2000 brand "heads" (first word of each product name) to ~20 via combined trigram + phonetic (pure-Python Double Metaphone) + `fuzz.ratio` signals, then asks Gemini to pick the right brand.
   - Stage 2 scores every SKU under that brand with `fuzz.WRatio` and asks Gemini to pick the exact SKU (dosage form / strength / combination-suffix rules are in the prompt).
   - Both stages return `top_candidates` so the frontend can offer a manual override if the AI pick is wrong.
3. **Supplier matching**: the extracted supplier string is fuzzy-matched (`rapidfuzz.WRatio`) against `ALL_SUPPLIERS`, loaded from `supplier_names.csv` in `config.py`.
4. **Browser automation** (`routes/browser.py`): once the user confirms the table, `/launch-browser` spawns a background thread with its own Playwright-driven Chromium (non-headless) logging into `shubhadahealth.com` and filling the "DC Inward" form. Two entry modes: `type` (fills each row field-by-field via keyboard, matching the Angular Material tab-stop order) or `excel` (generates an in-memory `.xlsx` and uses the page's hidden Excel-import input, then re-triggers each row's Angular server round-trip by nudging the product-name autocomplete — `retrigger_calculations`). Sessions are keyed by `tab_id` (persisted in the frontend's `sessionStorage`), tracked in the module-level `_sessions` dict, and controlled via `threading.Event`s (`kill`, `save`) so the frontend can request a save or the worker can report it's alive; a screenshot is written to `backend/screenshots/{session_id}/` for the frontend to poll. Windows requires `asyncio.ProactorEventLoop` for Playwright subprocess support in a background thread — see `_browser_worker`.
5. **Voice corrections** (`routes/voice.py`): audio is transcribed by ElevenLabs Scribe v2, then a Gemini call (JSON mode, `MATCHING_MODEL`) parses the transcript into either per-row `updates` (field/value on a product row) or `dc_updates` (header fields); `checked_by`/`supplier` values are then fuzzy-matched against `STAFF_NAMES`/`ALL_SUPPLIERS` the same way as the main extraction path.
6. **Inbox** (`routes/inbox.py` + `App.tsx`'s `InboxUploadPage`): a separate lightweight route, reached at `/inbox-upload` (checked via `window.location.pathname` in `App.tsx` rather than a router), meant to be opened on a phone via the Cloudflare tunnel QR code so someone can snap invoice photos on-site. Uploaded images land in `backend/inbox/`; the main desktop page polls `GET /inbox` every 10s and shows thumbnails, and clicking one both deletes it from the inbox and feeds it straight into the extract flow.
   - **Pipeline import** (WIP, uncommitted as of this writing): `GET /inbox/pipeline-suppliers` and `POST /inbox/import-from-pipeline?dc_number=&supplier_id=` proxy to an external "dc_pipeline" service at `DC_PIPELINE_URL` (default `http://localhost:3002`) — a separate system that stores DC records with photos tagged by type (`invoice`, `corrected`, `package`). Import pulls only `invoice`/`corrected` photos for a given DC+supplier and copies them into `backend/inbox/` so they flow through the same inbox UI. The Inbox section of `App.tsx` has a matching supplier-dropdown + DC-number input + "Fetch from Pipeline" button. This assumes `dc_pipeline` exposes `GET /suppliers` and `GET /stage2/find` — if that service's API changes, `_fetch_pipeline_json`/`import_from_pipeline` in `inbox.py` need updating.

### Config and shared data (`config.py`)

Loads `.env` (OpenRouter/ElevenLabs keys, `PORT`, `ALLOWED_ORIGINS`, `PRODUCT_LIST_PATH`/`PRODUCT_LIST_SHEET`, `DC_PIPELINE_URL`), loads `ALL_SUPPLIERS` from `supplier_names.csv`, and hardcodes `STAFF_NAMES` and (in `routes/browser.py`) per-branch login credentials for the two pharmacy branches (`HOSPET ROAD`, `SHIVAJI CHOWK`). Note `STAFF_NAMES` is duplicated verbatim in `frontend/src/App.tsx` — keep both in sync if the staff list changes.

### Frontend state (`frontend/src/App.tsx`)

Single top-level component holding all state; no router, no state library. Key DC fields and the extracted product table are persisted to `sessionStorage` (`dc_products`, `dc_number`, `dc_date`, `dc_supplier`, `dc_checked_by`, `dc_branch`, `dc_entry_mode`) so a page refresh mid-entry doesn't lose work, and a per-tab `tab_id` (also in `sessionStorage`) is used both as the Playwright session key and to re-fetch/restore that session's screenshot after a reload.
