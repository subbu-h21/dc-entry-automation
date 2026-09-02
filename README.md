# DC Entry Automation

Pharmacy invoice processing tool. Upload a photo of a delivery note → AI extracts product rows → fuzzy-matches against your CRM catalog → fill in the DC Entry web form automatically.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend | Python + FastAPI + Uvicorn |
| AI | Gemini via OpenRouter |
| Browser automation | Playwright |

---

## Setup (New Machine)

### Step 1 — Install prerequisites

| Tool | Download |
|---|---|
| Python 3.11+ | https://python.org/downloads |
| Node.js 18+ | https://nodejs.org |
| Git | https://git-scm.com |

### Step 2 — Clone the repo

```bash
git clone https://github.com/subbu-h21/dc-entry-automation.git
cd dc-entry-automation
```

### Step 3 — Run setup.bat

Double-click **`setup.bat`** in the project folder.

This will automatically:
- Create the Python virtual environment
- Install all backend Python dependencies
- Download the Playwright browser (Chromium)
- Install all frontend Node dependencies
- Create `backend\.env` from the template

### Step 4 — Fill in your API keys

Open `backend\.env` and add your values:

```env
OPENROUTER_API_KEY=sk-or-v1-...
ELEVENLABS_API_KEY=...
PORT=3001
ALLOWED_ORIGINS=http://localhost:5173
DC_PIPELINE_URL=http://localhost:3002
HOSPET_ROAD_USERNAME=...
HOSPET_ROAD_PASSWORD=...
SHIVAJI_CHOWK_USERNAME=...
SHIVAJI_CHOWK_PASSWORD=...
ADMIN_PIN=2009
```

> Get an OpenRouter key at https://openrouter.ai/keys

The four `*_USERNAME`/`*_PASSWORD` values are the CRM (`shubhadahealth.com`) login for
each branch — ask whoever manages that system if you don't have them. **Launch
Browser** (auto-filling the DC form) won't be able to log in without these set; every
other feature works fine without them.

`ADMIN_PIN` gates the **Admin** page (see below) — ships working with the default
shown above; change it here to rotate it.

`PRODUCT_LIST_PATH` defaults to `../Product_List.xlsx` (i.e. `Product_List.xlsx` at
the project root, next to `backend/` and `frontend/`) and doesn't need to be set
unless you're keeping that workbook somewhere else. The product matcher expects it
to have a sheet named `data` with columns like `PRODUCT`, `MANUFACTURER`, and `PACK`.
If it points to an older or different Excel file, extraction can succeed but product
matching will fail.

`DC_PIPELINE_URL` only needs changing if the separate `dc_pipeline` app (the
photo-logging tool the Inbox can import from — see Usage below) runs somewhere
other than `http://localhost:3002`.

### Step 5 — Launch the app

Double-click **`start.bat`**.

This builds the frontend, then starts **only the backend**, which serves both the
API and the built app together on **http://localhost:3001** (opened automatically
once the server is ready). There's no separate frontend dev server in this flow —
that's only for day-to-day development (see `CLAUDE.md`).

---

## Usage

1. Upload 1–2 pages of the invoice (JPEG, PNG, WebP — max 10 MB each; a second
   page can be added later without losing what's already been entered), plus an
   optional photo of the product packaging if you need to disambiguate a
   confusing item.
   - Instead of uploading from the desktop, you can also snap photos on a phone
     via the Inbox (`/inbox-upload` on the app's phone-accessible URL) and pick
     them up on the desktop page — or, if the same delivery was already
     photographed in the separate `dc_pipeline` app, pull those photos in
     directly by DC number + supplier via the Inbox's "Fetch from Pipeline".
2. Select the extraction model from the dropdown: **Lite** (default, Gemini
   3.1 Flash Lite) for smaller DCs, or **Lite 2** / **Pro** / **Pro 2** with
   **Reasoning** enabled for larger or multi-page ones.
3. Click **Extract Products**
4. Review and edit the extracted table
5. Click **Launch Browser** — this opens a visible Chromium window logged into
   the CRM with the DC form filled in. Review it there and click the CRM's own
   **Save** button to save the entry (there is no separate in-app save step);
   the app detects the save and credits it on the pharmacy's Stage 3 leaderboard.

---

## Admin page

Click **Admin** in the header (or go to `/admin` directly) to reach a PIN-gated
page (default PIN `2009`, see `ADMIN_PIN` above) for two things the shop owner
manages directly, without editing any code:

- **Employees** — add or remove names from the staff roster. This is the same
  list used by the "Checked By" dropdown and by voice-command matching
  ("checked by Ganesh" → the closest staff name) — an edit here takes effect
  immediately, no restart needed.
- **Product Catalog** — upload a replacement `.xlsx` file for the product
  catalog used for matching. It's validated (right sheet, right columns)
  *before* anything is replaced — an invalid file is rejected with a clear
  error and the live catalog is left untouched. A successful upload replaces
  the catalog immediately (again, no restart) and keeps one backup of the
  previous file (`Product_List.backup.xlsx`) so the last upload can be undone
  by hand if needed. PDF upload isn't supported yet, only Excel.

The PIN is checked by the backend on every admin request, not just hidden by
the page — so it can't be bypassed by skipping the PIN screen. That said, a
4-digit PIN with no limit on repeated wrong guesses is only a meaningful
barrier while this backend stays off the open internet; this app has no
broader login system beyond this one PIN check.

---

## Project Structure

```
dc-entry-automation/
├── backend/
│   ├── main.py                  # FastAPI app entry point
│   ├── config.py                # Env var loading
│   ├── requirements.txt
│   ├── .env.example             # Copy this to .env and fill in keys
│   ├── routes/
│   │   ├── extract.py           # POST /extract — image(s) → product rows
│   │   ├── browser.py           # POST /launch-browser — Playwright DC fill
│   │   ├── voice.py             # POST /voice/command — voice corrections
│   │   ├── products.py          # GET /suppliers, GET /staff, GET /products/search
│   │   ├── inbox.py             # GET/POST /inbox/* — phone uploads + dc_pipeline photo import
│   │   └── admin.py             # PIN-gated: staff add/remove, product-catalog upload
│   └── services/
│       ├── openrouter.py        # Gemini extraction via OpenRouter
│       ├── product_matcher.py   # Two-stage fuzzy SKU matching
│       ├── client.py            # OpenAI SDK clients → OpenRouter
│       └── matcher_instance.py  # Singleton matcher loaded from Excel
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Top-level state and layout
│   │   ├── styles.ts            # Shared style-object constants
│   │   └── components/
│   │       ├── ResultsTable.tsx # Editable table + voice UI
│   │       ├── ImageUpload.tsx  # Drag-and-drop upload
│   │       ├── AdminPage.tsx    # PIN-gated staff/catalog admin page
│   │       └── icons.tsx        # SVG icons
│   └── vite.config.ts           # Proxy: /extract, /launch-browser, /voice, /products,
│                                 #   /suppliers, /staff, /screenshot, /inbox, /admin → :3001
├── setup.bat                    # First-time setup script
└── start.bat                    # Build frontend, launch backend, open browser
```
