# Borehole Siting App (Awoja) — Implementation

This is a complete hybrid application (web + installers) that uses your trained `joblib` bundle to predict borehole siting suitability from **UTME/UTMN (UTM Zone 36N)** and shows results on a **MapTiler Satellite** basemap (with charts available in batch mode).

App name (branding): **BoreHole Sitter**

## What is implemented

- Backend: FastAPI loads `awoja_deployment_bundle.joblib` once and exposes:
  - `GET /health`
  - `GET /model-info`
  - `POST /predict` (single point or batch points)
- Frontend: React (Vite) app with:
  - Manual `UTME/UTMN` input
  - `Use my location` (device GPS/browser geolocation → coordinates update immediately, then backend converts to UTM Zone 36N and returns prediction)
  - Result card: decision, GPI, yield, SWL, recommendation
  - Map preview using **MapTiler Satellite** (falls back to OpenStreetMap if no MapTiler key)
  - Charts (ECharts) when you run **batch mode** (2+ points)
- Packaging setup:
  - Android APK wrapper using **Capacitor** (project created in `frontend/android/`)
  - Windows EXE/installer wrapper using **Tauri** (project created in `frontend/src-tauri/`)

## Run the backend (FastAPI)

1. Open a terminal in `backend/`
2. Install dependencies:
   - `python3 -m pip install -r requirements.txt --break-system-packages`
3. Run:
   - `MODEL_PATH=./models/awoja_deployment_bundle.joblib uvicorn app.main:app --reload --port 8000`

Backend will be available at `http://localhost:8000`.

Recommended environment variables for deployed environments:

- `CORS_ORIGINS=http://localhost,http://localhost:5173,http://127.0.0.1:5173,capacitor://localhost,ionic://localhost`
- `CORS_ORIGIN_REGEX=https://.*\.onrender\.com`
- `CORS_ALLOW_ALL=false`

These allow local development, Capacitor mobile shells, and Render-hosted frontend origins to call the API without failing the browser preflight request.

## Run the frontend (React)

1. Open a terminal in `frontend/`
2. Create your `.env` file:
   - Copy `./.env.example` to `./.env`
   - Set:
     - `VITE_API_BASE_URL=http://localhost:8000`
     - `VITE_MAPTILER_KEY=...` (your MapTiler key)
3. Install and run:
   - `npm install`
   - `npm run dev`

Frontend will be available at `http://localhost:5173`.

## Build a production web app (PWA)

The frontend is configured as a PWA (installable in the browser).

- `cd frontend`
- `npm run build`
- output is `frontend/dist/`

## Batch mode (charts)

To see charts, expand **Batch mode (for charts)** and paste multiple lines:

```
520000,180000
520250,180250
520500,180500
```

Then click **Predict suitability**. The backend returns a ranked list, and the frontend renders:
- Class distribution (Low/Medium/High)
- Yield vs GPI scatter
- SWL vs GPI scatter (inverted axis, like the notebook)

## Build Android APK (Capacitor)

The Android wrapper project already exists in `frontend/android/`.

Prerequisites on your machine:
- Android Studio + Android SDK
- A connected device or emulator

Steps:
1. `cd frontend`
2. Build web assets and sync into Android:
   - `npm run build`
   - `npx cap sync android`
3. Open Android Studio:
   - `npx cap open android`
4. In Android Studio:
   - Build an APK via **Build → Build Bundle(s) / APK(s) → Build APK(s)**

Important:
- The APK will still call your backend API. For a real field deployment, point `VITE_API_BASE_URL` to your hosted API domain.

## Build Windows EXE (Tauri)

Tauri setup exists in `frontend/src-tauri/`.

Prerequisites on Windows:
- Rust toolchain (stable)
- Visual Studio Build Tools (C++ tooling)

Steps (on Windows):
1. `cd frontend`
2. Install dependencies:
   - `npm install`
3. Build:
   - `npm run tauri build`

Tauri will output an installer / executable under:
- `frontend/src-tauri/target/release/bundle/`

## Notes

- The model bundle was exported with `scikit-learn==1.6.1`, so the backend pins that version to avoid compatibility issues.
- Coordinate system: **UTM Zone 36N (EPSG:32636)**.
- Render or Railway cold starts can delay the first prediction request; the frontend now warms the backend on load and shows a clearer timeout message when the API is still waking up.
- If you want the UI labels to say `Suitable / Moderate / Not suitable` only (without Low/Medium/High), we can hide `suitability_class` and show only `decision`.

## Functional requirements

- The app shall allow users to enter `UTME` and `UTMN` manually and request a borehole suitability prediction.
- The app shall allow users to use device location and immediately update the coordinate fields from the detected position before prediction completes.
- The app shall allow users to click the map and update the selected coordinates for the next prediction.
- The app shall show the best prediction result, including decision, GPI, predicted yield, predicted static water level, and recommendation.
- The backend shall accept either UTM coordinates or geographic coordinates and return a normalized prediction response.

## Non-functional requirements

- The backend shall respond to browser and mobile app requests with valid CORS headers for approved origins, including deployed frontend domains and Capacitor origins.
- The frontend shall surface backend, timeout, and connectivity failures with user-readable error messages instead of reporting every failure as a generic fetch issue.
- The app shall request and use location permissions on supported mobile devices before attempting to access device position.
- The first request to hosted infrastructure may be slower because of cold starts; the app should warm the service early and keep users informed while waiting.
- The app shall keep coordinate selection and map state synchronized so the displayed point matches the last user action.

## Build APK + EXE online (GitHub Actions)

If your PC cannot handle heavy development tools (Android Studio / Rust builds), you can build installers online using GitHub Actions.

### 1) Create a GitHub repo and push the project

1. Create a new GitHub repository (public or private).
2. Upload/push the `borehole-siting-app/` folder to the repo (make sure the `.github/workflows/` folder is included).
3. Ensure your default branch is `main` (or edit the workflow `branches: ["main"]` to match your branch).

After you push to `main`, GitHub will automatically run:
- `Build Windows (Tauri)` → produces EXE/installer bundle
- `Build Android (Capacitor APK)` → produces a debug APK

### 2) Add secrets (optional but recommended)

Go to: GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these (optional):
- `VITE_API_BASE_URL`:
  - Example: `https://your-api-domain.com`
  - If not set, the app defaults to `http://localhost:8000` (good for local dev, not for installers)
- `VITE_MAPTILER_KEY`:
  - Your MapTiler key for satellite tiles
  - If not set, the map falls back to OpenStreetMap (not satellite)

### 3) Download the built files (Artifacts)

1. GitHub repo → **Actions**
2. Click the latest run
3. Download the “Artifacts”:
   - `BoreHole-Sitter-windows-tauri-bundle` (contains the Windows installer/EXE)
   - `BoreHole-Sitter-android-apk-debug` (debug APK for testing)

### 4) Notes about the APK

The workflow produces a **debug** APK (`app-debug.apk`) which is easiest to build without signing.
For publishing to Play Store or distributing as a release APK, we can add APK signing (keystore + passwords) as GitHub secrets.

## GitHub upload guidance

Do not upload generated dependency folders like `node_modules` or build artifacts to GitHub.
This repo includes a root `.gitignore` file to ignore common generated files and folders, including:
- `node_modules/`
- `frontend/node_modules/`
- `frontend/dist/`
- `frontend/src-tauri/target/`
- `frontend/android/app/build/`
- `.venv/`, `.env`, `*.log`

If you already committed `node_modules`, remove it from git tracking before pushing:

```bash
git rm -r --cached frontend/node_modules
git commit -m "Remove node_modules from repo"
```

## Backend hosting options

Vercel can host a Python backend as a serverless function, but for this FastAPI + ML model backend it is usually better to use a service like Render or Railway.
Those platforms are more reliable for Python services with model files and are easier to use for this project.

Recommended hosting approach:
- Deploy the backend to Render.com or Railway.app
- Set the command to install dependencies and run the app:
  - `python -m pip install -r requirements.txt`
  - `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Then set `VITE_API_BASE_URL` in GitHub Secrets to your hosted backend URL.

If you still want Vercel:
- the backend must be converted to a Python serverless function under `api/`
- the model file must be included in the deployment bundle
- Vercel works for testing, but Render/Railway is generally better for this use case
