from __future__ import annotations

import os
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .model_runtime import AwojaModelRuntime


MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(os.path.dirname(__file__), "..", "models", "awoja_deployment_bundle.joblib"))
MODEL_PATH = os.path.abspath(MODEL_PATH)


app = FastAPI(title="Awoja Borehole Siting API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()],
    allow_credentials=True,
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


@app.on_event("startup")
def _load_model() -> None:
    global runtime
    if not os.path.exists(MODEL_PATH):
        raise RuntimeError(f"MODEL_PATH not found: {MODEL_PATH}")
    runtime = AwojaModelRuntime(MODEL_PATH)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "model_loaded": runtime is not None}


@app.get("/model-info")
def model_info() -> Dict[str, Any]:
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


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
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
