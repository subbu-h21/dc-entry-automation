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
cd frontend && npm run dev                                # Vite dev server on :5173, proxies /extract, /launch-browser, /voice, /products, /suppliers, /screenshot, /inbox to :3001 (see vite.config.ts)
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
This is **not** the dev workflow above — it builds the frontend (`npm run build`), then starts only the backend (`python main.py`), which serves the API *and* the built SPA from `frontend/dist` via the catch-all route in `main.py`, on port 3001 (not 5173). It no longer launches a Cloudflare quick tunnel automatically — the phone-camera "inbox" flow now reaches the backend via a stable domain set up outside this repo, not a random `*.trycloudflare.com` URL. `tunnel.py` (a Cloudflare quick-tunnel + QR code script) still exists in the repo for ad-hoc use but isn't invoked by `start.bat` anymore.

### Tests
There is no test suite in this repo (no test files, no test runner configured) — verify changes by running the app end-to-end.

## Architecture

Two-part app under `dc-entry-automation/`: a FastAPI backend and a React/Vite/TS frontend, joined either by the Vite proxy (dev) or by FastAPI serving the built SPA directly (prod, see `main.py`'s catch-all `serve_spa` route).

### Request flow: image → filled DC form

1. **Extraction** (`routes/extract.py` → `services/openrouter.py`): 1–2 uploaded invoice page images (multi-page DCs — `images: list[UploadFile]`, capped at 2) plus an optional third "product packaging" photo for disambiguation are sent to a Gemini model via OpenRouter using forced tool-calling (`EXTRACTION_TOOL`) so the model returns structured JSON (`dc_number`, `dc_date`, `supplier_name`, `products[]`) instead of free text. When 2 invoice pages are sent, an extra prompt block tells Gemini they're consecutive pages of the same document and to combine every product row into one `products` array. The prompt encodes pharmacy-invoice-specific rules (e.g. the `"5+1"` free-qty notation, stripping MFR/HSN code columns from the product name) that later post-processing re-enforces as a fallback (`_fix_free_qty`, `_fix_expiry`, `_fix_batch` in `extract.py`).
2. **Product matching** (`services/product_matcher.py`, singleton in `services/matcher_instance.py`): a two-stage fuzzy match against the pharmacy's own catalog (`Product_List.xlsx`, sheet `data`, columns `PRODUCT`/`MANUFACTURER`/`PACK`, path from `PRODUCT_LIST_PATH`).
   - Stage 1 narrows ~2000 brand "heads" (first word of each product name) to ~20 via combined trigram + phonetic (pure-Python Double Metaphone) + `fuzz.ratio` signals, then asks Gemini to pick the right brand.
   - Stage 2 scores every SKU under that brand with `fuzz.WRatio` and asks Gemini to pick the exact SKU (dosage form / strength / combination-suffix rules are in the prompt).
   - Both stages return `top_candidates` so the frontend can offer a manual override if the AI pick is wrong.
3. **Supplier matching**: the extracted supplier string is fuzzy-matched (`rapidfuzz.WRatio`) against `ALL_SUPPLIERS`, loaded from `supplier_names.csv` in `config.py`.
4. **Browser automation** (`routes/browser.py`): once the user confirms the table, `/launch-browser` spawns a background thread with its own Playwright-driven Chromium (non-headless) logging into `shubhadahealth.com` and filling the "DC Inward" form. Two entry modes: `type` (fills each row field-by-field via keyboard, matching the Angular Material tab-stop order) or `excel` (generates an in-memory `.xlsx` and uses the page's hidden Excel-import input, then re-triggers each row's Angular server round-trip by nudging the product-name autocomplete — `retrigger_calculations`). Sessions are keyed by `tab_id` (persisted in the frontend's `sessionStorage`), tracked in the module-level `_sessions` dict, and controlled via a `threading.Event` (`kill`) so the frontend can end the session, plus an `alive` event the worker sets/clears to report its own status; a screenshot is written to `backend/screenshots/{session_id}/` for the frontend to poll. Windows requires `asyncio.ProactorEventLoop` for Playwright subprocess support in a background thread — see `_browser_worker`. Employees save the DC by clicking the CRM's own Save button directly inside this visible Chromium window (there is no in-app "Save DC" button — removed since it went unused). The session's poll loop instead watches the page itself for the CRM's save-confirmation dialog and, on a match, reports the save to `dc_pipeline` (`POST {DC_PIPELINE_URL}/stage3/save`) via `httpx` so it's credited on that app's employee leaderboard as "Stage 3" — see `_check_stage3_success`/`_report_stage3`. The dialog text-match pattern is unverified against the live CRM and may need tightening.
5. **Voice corrections** (`routes/voice.py`): audio is transcribed by ElevenLabs Scribe v2, then a Gemini call (JSON mode, `MATCHING_MODEL`) parses the transcript into either per-row `updates` (field/value on a product row) or `dc_updates` (header fields); `checked_by`/`supplier` values are then fuzzy-matched against `STAFF_NAMES`/`ALL_SUPPLIERS` the same way as the main extraction path.
6. **Inbox** (`routes/inbox.py` + `App.tsx`'s `InboxUploadPage`): a separate lightweight route, reached at `/inbox-upload` (checked via `window.location.pathname` in `App.tsx` rather than a router), meant to be opened on a phone (via the stable domain the app is served on) so someone can snap invoice photos on-site. Uploaded images land in `backend/inbox/`; the main desktop page polls `GET /inbox` every 10s and shows thumbnails. Clicking a thumbnail routes it by `photo_type` (see below) into the right upload slot and removes it from the inbox — it no longer triggers extraction automatically; the user reviews the model/reasoning settings and clicks "Extract Products" themselves.
   - **Pipeline import** — a second, non-phone way for images to land in the same inbox. `GET /inbox/pipeline-suppliers` and `POST /inbox/import-from-pipeline?dc_number=&supplier_id=` call out to `dc_pipeline` — a separate, unrelated app (own FastAPI + SQLite, own repo, no git relationship to this one) that runs a two-stage DC-photo-logging workflow *before* this app's extraction step, normally on `http://localhost:3002` (configurable via `DC_PIPELINE_URL`). Import fetches the `invoice`/`corrected`/`package` photo types for a given `(dc_number, supplier_id)` via `dc_pipeline`'s existing `/stage2/find` + `/photos/{id}` endpoints, and writes the raw response bytes straight to disk with no re-encoding — verified byte-for-byte identical (SHA256) to the original camera file, so resolution/EXIF survive intact. This is a one-way, read-only, server-to-server call: `dc-entry-automation` never opens `dc_pipeline`'s database or files directly, and `dc_pipeline` needed zero changes to support it — deliberate, to avoid coupling to its internal schema. If `dc_pipeline` is unreachable → clean `502`; if the DC doesn't exist there → clean `404`; if a specific photo already aged out of `dc_pipeline`'s own 7-day photo-retention cleanup (`_photo_cleanup_loop` in its `main.py`, unrelated to this app) → that one photo is skipped rather than failing the whole import. The Inbox section of `App.tsx` has a matching supplier dropdown (populated from `dc_pipeline`'s real `supplier_id`s — a different set of IDs than this app's own `ALL_SUPPLIERS`) + DC-number input + "Fetch from Pipeline" button.
   - **Photo type routing**: each inbox item carries a `photo_type` (`invoice`/`corrected`/`package`), inferred from a filename prefix (`_infer_photo_type` in `routes/inbox.py`) that pipeline-imported files get stamped with at write time; phone/manual uploads have no prefix and default to `invoice`. `App.tsx` uses this to route a clicked thumbnail: `package` → the "Product's Image" box; anything else → appended to `invoiceFiles` (see below) if it's under the 2-page cap. If already at the cap, the click is a no-op and the photo stays in the inbox rather than being lost — a DC with more than 2 non-package photos (e.g. several `corrected` re-uploads) will need one removed first before the rest can be used.

### Config and shared data (`config.py`)

Loads `.env` (OpenRouter/ElevenLabs keys, `PORT`, `ALLOWED_ORIGINS`, `PRODUCT_LIST_PATH`/`PRODUCT_LIST_SHEET`, `DC_PIPELINE_URL`), loads `ALL_SUPPLIERS` from `supplier_names.csv`, and hardcodes `STAFF_NAMES` and (in `routes/browser.py`) per-branch login credentials for the two pharmacy branches (`HOSPET ROAD`, `SHIVAJI CHOWK`). Note `STAFF_NAMES` is duplicated verbatim in `frontend/src/App.tsx` — keep both in sync if the staff list changes.

### Frontend state (`frontend/src/App.tsx`)

Single top-level component holding all state; no router, no state library. Key DC fields and the extracted product table are persisted to `sessionStorage` (`dc_products`, `dc_number`, `dc_date`, `dc_supplier`, `dc_checked_by`, `dc_branch`, `dc_entry_mode`) so a page refresh mid-entry doesn't lose work, and a per-tab `tab_id` (also in `sessionStorage`) is used both as the Playwright session key and to re-fetch/restore that session's screenshot after a reload.

Invoice pages are `invoiceFiles: File[]` (0–2 items, object-URL previews in `invoicePreviews` kept in sync via a `useEffect` that revokes stale URLs), fed through a single `handleInvoiceFilesChange` that only resets the rest of the form (`resetEntryState`) when going from 0 files to 1+ — adding a second page to an in-progress entry doesn't wipe `dc_number`/`products`/etc. `components/ImageUpload.tsx` is the shared upload widget for both this and the separate "Product's Image" box: it takes `selectedFiles`/`previewUrls` arrays and a `maxFiles` prop (default 1). At `maxFiles === 1` (Product's Image) it behaves as a classic single-file picker (click-to-replace, one big "Remove" button); at `maxFiles > 1` (invoice, `maxFiles={2}`) the same drop zone/browse/camera **adds** photos instead of replacing until the cap is hit, each with its own small "×", and the drop zone hides itself once full — the only way to swap a photo at the cap is to remove one first.
