# DC Entry Automation

Pharmacy invoice processing tool. Upload a photo of a delivery note → AI extracts product rows → fuzzy-matches against your CRM catalog → checks and saves the DC in the CRM through its API.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite + TypeScript |
| Backend | Python + FastAPI + Uvicorn |
| AI | Claude for reading DCs, Gemini via OpenRouter for the rest |
| CRM | DC Inward API |

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
- Install all frontend Node dependencies
- Create `backend\.env` from the template

### Step 4 — Fill in your API keys

Open `backend\.env` and add your values:

```env
OPENROUTER_API_KEY=sk-or-v1-...
ELEVENLABS_API_KEY=...
ANTHROPIC_KEY=...
PORT=3001
ALLOWED_ORIGINS=http://localhost:5173
DC_PIPELINE_URL=http://localhost:3002
CRM_API_BASE_URL=http://app.shubhadahealth.com/api
CRM_CLIENT_ID=...
CRM_CLIENT_SECRET=...
CRM_DEFAULT_EMPLOYEE_ID=386
ADMIN_PIN=2009
```

> Get an OpenRouter key at https://openrouter.ai/keys

`ANTHROPIC_KEY` is for Claude, which reads the DC photos on the **Lite** and **Pro**
models. Create it at https://platform.claude.com/settings/keys in the organisation
that holds your monthly API credit, because a key from another organisation has no
credit to spend. If it's blank, or Claude fails for any reason, those models quietly
use Gemini through OpenRouter instead, and only the backend log says so.

The `CRM_*` values connect this app to the CRM's DC Inward API. **Saving a DC raises
stock in whichever CRM `CRM_API_BASE_URL` points at**, and it has no default on
purpose. `app.shubhadahealth.com` is the test server. The client ID and secret come
from the CRM's API Clients screen, and must stay in this file on the server.
`CRM_DEFAULT_EMPLOYEE_ID` is who a DC shows as Created By when the Checked By person
isn't set up for that branch in the CRM. Without these settings the Supplier and
Checked By lists stay empty and DCs can't be saved.

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
2. Select the extraction model from the dropdown: **Lite** (default, Claude
   Sonnet 5.5) for smaller DCs, or **Pro** (Claude Opus 5.5) for larger or
   multi-page ones. The other models are still there as **Lite 2**, **Lite 3**,
   **Pro 2** and **Pro 3**, and the last three can use **Reasoning**.
3. Click **Extract Products**
4. Review and edit the extracted table. While you do, Claude Opus double-checks it
   against the photo, which takes about 10–20 seconds and a few cents of the Claude
   credit. The **Second check** box then lists anything that looks wrong, and those
   cells turn orange. **Use** puts in what the DC shows, **Ignore** dismisses it.
   Nothing changes by itself. Rows whose printed value doesn't add up, and a printed
   item count or total quantity that doesn't match, are flagged at once, for free.
5. Click **Check DC**. Nothing is saved yet: the CRM checks the DC and lists any
   problems.
   - **Not allowed:** fix the value in the table and check again. If the value
     really is right, click **Leave out** and add that row on the CRM screen later.
   - **Please confirm:** a person must tick each question.
6. Click **Save to CRM**. Stock goes up immediately, the reference is shown, and
   the save is credited on the pharmacy's Stage 3 leaderboard. A saved DC can only
   be changed on the CRM's DC Inward screen.

---

## Admin page

Click **Admin** in the header (or go to `/admin` directly) to reach a PIN-gated
page (default PIN `2009`, see `ADMIN_PIN` above) where the shop owner can replace
the product catalog without editing any code. Suppliers and staff are managed in
the CRM, and this app reads them from there.

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
│   │   ├── crm.py               # POST /crm/dc/check, /crm/dc/save — send the DC to the CRM; GET /crm/dc/products/search for Change
│   │   ├── voice.py             # POST /voice/command — voice corrections
│   │   ├── products.py          # GET /suppliers, GET /staff, GET /products/search (Excel catalogue)
│   │   ├── inbox.py             # GET/POST /inbox/* — phone uploads + dc_pipeline photo import
│   │   └── admin.py             # PIN-gated: product-catalog upload
│   └── services/
│       ├── crm_api.py           # All calls to the CRM's DC Inward API
│       ├── openrouter.py        # Reads the DC: Claude directly, or a model via OpenRouter
│       ├── pen_marks.py         # Reads red pen marks, reports supplier mistakes to dc_pipeline
│       ├── product_matcher.py   # Two-stage fuzzy SKU matching
│       ├── client.py            # OpenAI SDK clients → OpenRouter and Anthropic
│       └── matcher_instance.py  # Singleton matcher loaded from Excel
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Top-level state and layout
│   │   ├── styles.ts            # Shared style-object constants
│   │   └── components/
│   │       ├── ResultsTable.tsx # Editable table + voice UI
│   │       ├── ImageUpload.tsx  # Drag-and-drop upload
│   │       ├── DcSubmitPanel.tsx # Check, confirm and save to the CRM
│   │       ├── AdminPage.tsx    # PIN-gated catalog admin page
│   │       └── icons.tsx        # SVG icons
│   └── vite.config.ts           # Proxy: /extract, /crm, /voice, /products,
│                                 #   /suppliers, /staff, /inbox, /admin → :3001
├── setup.bat                    # First-time setup script
└── start.bat                    # Build frontend, launch backend, open browser
```
