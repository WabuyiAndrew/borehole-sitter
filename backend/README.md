# Backend FastAPI Setup

## Setup

1. Create and activate a Python virtual environment:

```bash
python -m venv .venv
source .venv/bin/activate   # macOS / Linux
.venv\Scripts\activate    # Windows
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

## Run the FastAPI app

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Test

Open `http://127.0.0.1:8000` in your browser.

Swagger UI is available at `http://127.0.0.1:8000/docs`.
