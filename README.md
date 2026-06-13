# Pharmacy Bill Extractor

Extract product name, quantity, and batch number from pharmacy purchase invoices using Gemini 2.5 Flash via OpenRouter.

## Stack

- **Frontend**: React + Vite + TypeScript
- **Backend**: Python + FastAPI + Uvicorn
- **LLM**: Gemini 2.5 Flash via OpenRouter (OpenAI Python SDK)

---

## Setting Up on a New Computer

### Prerequisites — install these first
- [Python 3.11+](https://python.org/downloads)
- [Node.js 18+](https://nodejs.org)
- [Git](https://git-scm.com)

### 1. Clone the repo
```bash
git clone https://github.com/subbu-h21/dc-entry-automation.git
cd dc-entry-automation
```

### 2. Set up the backend
```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium
```

Create the `.env` file:
```bash
copy .env.example .env
```

Open `.env` and fill in your real values:
```
OPENROUTER_API_KEY=sk-or-v1-...
ELEVENLABS_API_KEY=...
PRODUCT_LIST_PATH=C:\path\to\your\Product_List.xlsx
PRODUCT_LIST_SHEET=data
PORT=3001
```

### 3. Set up the frontend
```bash
cd ..\frontend
npm install
```

### 4. Run (two terminals)

**Terminal 1 — Backend:**
```bash
cd backend
venv\Scripts\activate
python main.py
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```

Open **http://localhost:5173** in the browser.

> **Note:** Two things to bring manually to the new machine:
> - Your API keys (fill them into `.env`)
> - The `Product_List.xlsx` catalog file — copy it over and update `PRODUCT_LIST_PATH` in `.env`

---

## Local Development Setup

### 1. Clone / open the project

```
d:\code_files\dc image recognition\
├── backend\
└── frontend\
```

### 2. Configure the backend API key

```bash
cd backend
copy .env.example .env
```

Edit `.env` and add your key:
```
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxx
PORT=3001
```

Get a key at https://openrouter.ai/keys

### 3. Install dependencies

```bash
# Backend (Python)
cd backend
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install
```

### 4. Run (two terminals)

**Terminal 1 — Backend:**
```bash
cd backend
venv\Scripts\activate
python main.py
```
Backend starts on http://localhost:3001

**Terminal 2 — Frontend:**
```bash
cd frontend
npm run dev
```
Frontend starts on http://localhost:5173

---

## Usage

1. Open http://localhost:5173 in your browser
2. Upload a pharmacy invoice image (JPEG, PNG, WebP, GIF — max 10 MB)
3. Click **Extract Products**
4. View the extracted table with Product Name, Quantity, and Batch Number
5. Use **Copy CSV** to copy the data to clipboard

---

## API

### `POST /extract`

**Request:** `multipart/form-data` with field `image`

**Response:**
```json
{
  "products": [
    {
      "product_name": "BETADINE 10% SOLUTION",
      "quantity": 3,
      "batch_number": "MD051263"
    }
  ]
}
```

**Errors:**
```json
{ "error": "Human-readable error message" }
```

---

## Project Structure

```
backend/
  main.py               # FastAPI app, CORS, dotenv, uvicorn entry
  routes/
    extract.py          # POST /extract route, file validation, error mapping
  services/
    openrouter.py       # OpenAI Python SDK → OpenRouter → Gemini, tool calling
  requirements.txt
  .env.example

frontend/
  src/
    App.tsx             # Main page layout and state
    components/
      ImageUpload.tsx   # Drag-and-drop file picker + preview
      ResultsTable.tsx  # Extracted products table + CSV copy
    main.tsx
    index.css
  vite.config.ts        # Dev proxy: /extract → localhost:3001
```
