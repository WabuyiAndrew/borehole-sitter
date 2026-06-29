from __future__ import annotations

import os
from io import BytesIO
from typing import Any, Dict, List, Literal, Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import AliasChoices, BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import create_access_token, get_current_user, get_db, hash_password, verify_password
from .db import engine
from .models import Base, User
from .model_runtime import AwojaModelRuntime, MODEL_UTM_NORTHERN, MODEL_UTM_ZONE
from .pdf_report import build_pdf_report


MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "models", "awoja_deployment_bundle.joblib"))
MODEL_PATH = os.path.abspath(MODEL_PATH)


app = FastAPI(title="Awoja Borehole Siting API", version="0.1.0")


def _parse_csv_env(name: str, default: str) -> List[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


default_origins = ",".join(
    [
        "http://localhost",
        "http://localhost:3000",
        "http://localhost:4173",
        "http://localhost:5173",
        "http://127.0.0.1",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:4173",
        "http://127.0.0.1:5173",
        "capacitor://localhost",
        "ionic://localhost",
    ]
)
allowed_origins = _parse_csv_env("CORS_ORIGINS", default_origins)
allow_all_origins = os.getenv("CORS_ALLOW_ALL", "").strip().lower() in {"1", "true", "yes"}
allow_origin_regex = os.getenv("CORS_ORIGIN_REGEX", r"https://.*\.onrender\.com")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if allow_all_origins else allowed_origins,
    allow_origin_regex=None if allow_all_origins else allow_origin_regex,
    # Wildcard origins cannot be combined with credentialed requests.
    allow_credentials=not allow_all_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


runtime: Optional[AwojaModelRuntime] = None


class ClientInfo(BaseModel):
    app_version: Optional[str] = None
    device: Optional[str] = None


class PointUTM(BaseModel):
    utme: float = Field(..., description="Easting (meters) in UTM Zone 36N (EPSG:32636)")
    utmn: float = Field(..., description="Northing (meters) in UTM Zone 36N (EPSG:32636)")


class PointGeo(BaseModel):
    longitude: float = Field(..., description="Longitude in degrees (EPSG:4326)")
    latitude: float = Field(..., description="Latitude in degrees (EPSG:4326)")


class ConvertPointUTM(BaseModel):
    utme: float = Field(..., description="Easting (meters) in the supplied UTM zone/hemisphere")
    utmn: float = Field(..., description="Northing (meters) in the supplied UTM zone/hemisphere")
    zone: int = Field(default=MODEL_UTM_ZONE, ge=1, le=60, description="UTM zone number (1-60)")
    northern: bool = Field(default=MODEL_UTM_NORTHERN, description="True for northern hemisphere, false for southern hemisphere")


class PredictRequest(BaseModel):
    source: Literal["manual", "geolocation"] = "manual"
    point_utm: Optional[PointUTM] = None
    point_geo: Optional[PointGeo] = None

    # Optional batch mode (for charts + ranking like your notebook)
    points_utm: Optional[List[PointUTM]] = Field(default=None, description="Optional batch prediction; max 500")

    client: Optional[ClientInfo] = None


class PredictResponse(BaseModel):
    # If batch: results list is returned (sorted by gpi desc) + best item
    best: Dict[str, Any]
    results: List[Dict[str, Any]]
    warnings: List[str] = []
    bundle_version: str


class CoordinateReference(BaseModel):
    utme: float
    utmn: float
    longitude: float
    latitude: float
    zone: int
    northern: bool
    epsg: int


class ConvertCoordinatesRequest(BaseModel):
    point_geo: Optional[PointGeo] = None
    point_utm: Optional[ConvertPointUTM] = None


class ConvertCoordinatesResponse(BaseModel):
    input_mode: Literal["geo", "utm"]
    authoritative: CoordinateReference
    model: CoordinateReference


class AuthRequest(BaseModel):
    email: EmailStr = Field(..., validation_alias=AliasChoices("email", "username"))
    password: str = Field(..., min_length=7, max_length=256)


class AuthResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class PdfReportRequest(BaseModel):
    point_geo: PointGeo
    best: Dict[str, Any]
    results: List[Dict[str, Any]]
    title: Optional[str] = None
    place_name: Optional[str] = None
    place_details: Optional[str] = None


@app.on_event("startup")
def _load_model() -> None:
    global runtime
    Base.metadata.create_all(bind=engine)
    if not os.path.exists(MODEL_PATH):
        raise RuntimeError(f"MODEL_PATH not found: {MODEL_PATH}")
    runtime = AwojaModelRuntime(MODEL_PATH)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "model_loaded": runtime is not None}


@app.get("/")
def root() -> Dict[str, Any]:
    return {"ok": True, "service": "borehole-sitter-api"}


@app.post("/auth/signup", response_model=AuthResponse)
def auth_signup(payload: AuthRequest, db: Session = Depends(get_db)) -> AuthResponse:
    username = str(payload.email).strip().lower()
    if not username:
        raise HTTPException(status_code=400, detail="Email is required")
    user = User(username=username, password_hash=hash_password(payload.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Email already exists")
    token = create_access_token(user.username)
    return AuthResponse(access_token=token)


@app.post("/auth/login", response_model=AuthResponse)
def auth_login(payload: AuthRequest, db: Session = Depends(get_db)) -> AuthResponse:
    username = str(payload.email).strip().lower()
    user = db.execute(select(User).where(User.username == username)).scalars().first()
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_access_token(user.username)
    return AuthResponse(access_token=token)


@app.get("/model-info")
def model_info(_: User = Depends(get_current_user)) -> Dict[str, Any]:
    if runtime is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    info = runtime.info()
    return {
        "name": info.name,
        "created_at": info.created_at,
        "coordinate_system": "UTM Zone 36N (EPSG:32636)",
        "gpi_thresholds": {"q25": info.gpi_q25, "q75": info.gpi_q75},
        "feature_columns_count": len(info.feat_cols),
        "numeric_features_count": len(info.num_feats),
        "categorical_features_count": len(info.cat_feats),
        "units": {"utme": "m", "utmn": "m", "predicted_yield_m3h": "m³/h", "predicted_static_water_level_m": "m", "gpi": "0-100"},
    }


@app.post("/convert-coordinates", response_model=ConvertCoordinatesResponse)
def convert_coordinates(req: ConvertCoordinatesRequest, _: User = Depends(get_current_user)) -> ConvertCoordinatesResponse:
    if runtime is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    has_geo = req.point_geo is not None
    has_utm = req.point_utm is not None
    if has_geo == has_utm:
        raise HTTPException(status_code=400, detail="Provide exactly one of point_geo or point_utm")

    if req.point_geo is not None:
        converted = runtime.convert_from_geo(req.point_geo.longitude, req.point_geo.latitude)
        return ConvertCoordinatesResponse(input_mode="geo", **converted)

    assert req.point_utm is not None
    converted = runtime.convert_from_utm(
        req.point_utm.utme,
        req.point_utm.utmn,
        zone=req.point_utm.zone,
        northern=req.point_utm.northern,
    )
    return ConvertCoordinatesResponse(input_mode="utm", **converted)


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest, _: User = Depends(get_current_user)) -> PredictResponse:
    if runtime is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    warnings: List[str] = []

    # Batch mode
    if req.points_utm:
        if len(req.points_utm) > 500:
            raise HTTPException(status_code=400, detail="Too many points (max 500)")
        results = [runtime.predict_one_utm(p.utme, p.utmn) for p in req.points_utm]
        results = sorted(results, key=lambda r: float(r.get("gpi", 0.0)), reverse=True)
        best = results[0] if results else {}
        return PredictResponse(best=best, results=results, warnings=warnings, bundle_version=str(runtime.bundle.get("model_names", "awoja")))

    # Single point mode: accept either UTM or Geo
    utm = req.point_utm
    if utm is None and req.point_geo is not None:
        e, n = runtime.geo_to_utm36(req.point_geo.longitude, req.point_geo.latitude)
        utm = PointUTM(utme=e, utmn=n)

    if utm is None:
        raise HTTPException(status_code=400, detail="Provide point_utm or point_geo")

    result = runtime.predict_one_utm(utm.utme, utm.utmn)
    return PredictResponse(best=result, results=[result], warnings=warnings, bundle_version=str(runtime.bundle.get("model_names", "awoja")))


@app.post("/report/pdf")
def report_pdf(req: PdfReportRequest, _: User = Depends(get_current_user)) -> StreamingResponse:
    pdf_bytes = build_pdf_report(
        title=req.title or "DrillScout report",
        point=(req.point_geo.latitude, req.point_geo.longitude),
        best=req.best,
        results=req.results,
        place_name=req.place_name,
        place_details=req.place_details,
    )
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": 'attachment; filename="drillscout-report.pdf"'},
    )
