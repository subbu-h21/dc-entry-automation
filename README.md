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
PRODUCT_LIST_PATH=D:\code_files\dc\dc image recognition v3.0.1\dc-entry-automation\Product_List.xlsx
```

> Get an OpenRouter key at https://openrouter.ai/keys

Always update `PRODUCT_LIST_PATH` after setup so it points to the `Product_List.xlsx`
file inside this project folder. The product matcher expects that workbook to have a
sheet named `data` with columns like `PRODUCT`, `MANUFACTURER`, and `PACK`. If this
path points to an older or different Excel file, extraction can succeed but product
matching will fail.

### Step 5 — Launch the app

Double-click **`start.bat`**.

This opens the backend and frontend in separate terminal windows and automatically opens **http://localhost:5173** in your browser.

---

## Usage

1. Upload a pharmacy invoice image (JPEG, PNG, WebP — max 10 MB)
2. Select the extraction model:
   - **3.1 Flash Lite** — faster, good for smaller DCs
   - **2.5 Pro** — more accurate, use with Reasoning on for larger DCs
3. Click **Extract Products**
4. Review and edit the extracted table
5. Click **Launch Browser** to auto-fill the DC Entry form

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
│   │   ├── extract.py           # POST /extract — image → product rows
│   │   ├── browser.py           # POST /launch-browser — Playwright DC fill
│   │   ├── voice.py             # POST /voice/command — voice corrections
│   │   └── products.py          # GET /products — catalog lookup
│   └── services/
│       ├── openrouter.py        # Gemini extraction via OpenRouter
│       ├── product_matcher.py   # Two-stage fuzzy SKU matching
│       ├── client.py            # OpenAI SDK clients → OpenRouter
│       └── matcher_instance.py  # Singleton matcher loaded from Excel
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # Top-level state and layout
│   │   └── components/
│   │       ├── ResultsTable.tsx # Editable table + voice UI
│   │       ├── ImageUpload.tsx  # Drag-and-drop upload
│   │       └── icons.tsx        # SVG icons
│   └── vite.config.ts           # Proxy: /extract, /launch-browser, /voice → :3001
├── setup.bat                    # First-time setup script
└── start.bat                    # Launch both servers + open browser
```
