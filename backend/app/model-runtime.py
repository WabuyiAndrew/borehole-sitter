from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd
from pyproj import Transformer


@dataclass(frozen=True)
class ModelInfo:
    name: str
    created_at: Optional[str]
    feat_cols: List[str]
    num_feats: List[str]
    cat_feats: List[str]
    gpi_q25: float
    gpi_q75: float


class AwojaModelRuntime:
    """
    Loads the joblib bundle and exposes prediction helpers.

    Notes
    - The logic is adapted from `awoja_tool_only_app.ipynb`.
    - Coordinate system for UTME/UTMN is UTM Zone 36N (EPSG:32636).
    """

    def __init__(self, bundle_path: str):
        self.bundle_path = bundle_path
        self.bundle: Dict[str, Any] = joblib.load(bundle_path)

        self.model_swl = self.bundle["models"]["StaticWaterLevel"]
        self.model_yield = self.bundle["models"]["TotalYield"]

        self.FEAT_COLS: List[str] = list(self.bundle["FEAT_COLS"])
        self.NUM_FEATS: List[str] = list(self.bundle["NUM_FEATS"])
        self.CAT_FEATS: List[str] = list(self.bundle["CAT_FEATS"])

        self.feature_defaults: Dict[str, Any] = dict(self.bundle.get("feature_defaults", {}))
        self.target_ranges: Dict[str, Any] = dict(self.bundle.get("target_ranges", {}))

        self.background_df: pd.DataFrame = self.bundle["background_df"].copy()
        self.background_df["UTME"] = pd.to_numeric(self.background_df["UTME"], errors="coerce")
        self.background_df["UTMN"] = pd.to_numeric(self.background_df["UTMN"], errors="coerce")
        self.background_df = self.background_df.dropna(subset=["UTME", "UTMN"]).reset_index(drop=True)
        self.background_xy = self.background_df[["UTME", "UTMN"]].to_numpy(dtype=float)

        # Fast nearest-neighbour lookup if SciPy is available (it is in requirements)
        try:
            from scipy.spatial import cKDTree  # type: ignore

            self.background_tree = cKDTree(self.background_xy)
        except Exception:
            self.background_tree = None

        # Coordinate transforms
        self._geo_to_utm36 = Transformer.from_crs("EPSG:4326", "EPSG:32636", always_xy=True)
        self._utm36_to_geo = Transformer.from_crs("EPSG:32636", "EPSG:4326", always_xy=True)

    def info(self) -> ModelInfo:
        return ModelInfo(
            name=str(self.bundle.get("model_names", "awoja")),
            created_at=self.bundle.get("created_at"),
            feat_cols=self.FEAT_COLS,
            num_feats=self.NUM_FEATS,
            cat_feats=self.CAT_FEATS,
            gpi_q25=float(self.target_ranges.get("gpi_q25", 33.0)),
            gpi_q75=float(self.target_ranges.get("gpi_q75", 67.0)),
        )

    # -----------------------
    # Coordinates
    # -----------------------
    def geo_to_utm36(self, lon: float, lat: float) -> Tuple[float, float]:
        e, n = self._geo_to_utm36.transform(lon, lat)
        return float(e), float(n)

    def utm36_to_geo(self, utme: float, utmn: float) -> Tuple[float, float]:
        lon, lat = self._utm36_to_geo.transform(utme, utmn)
        return float(lon), float(lat)

    # -----------------------
    # Feature preparation
    # -----------------------
    @staticmethod
    def _first_available(row: Dict[str, Any], *cols: str, default: float = 0.0) -> float:
        for col in cols:
            if col in row and pd.notna(row[col]):
                return float(row[col])
        return float(default)

    def _prepare_model_features(self, raw_values: Dict[str, Any]) -> pd.DataFrame:
        row: Dict[str, Any] = dict(raw_values)

        for col in self.NUM_FEATS:
            if col not in row or pd.isna(row[col]):
                row[col] = self.feature_defaults.get(col, 0.0)

        utme = self._first_available(row, "UTME", default=self.feature_defaults.get("UTME", 0.0))
        utmn = self._first_available(row, "UTMN", default=self.feature_defaults.get("UTMN", 0.0))
        elevation = self._first_available(row, "Elevation", default=self.feature_defaults.get("Elevation", 0.0))
        slope = self._first_available(
            row, "Slope_Value", "slope", "Slope", default=self.feature_defaults.get("Slope_Value", 0.0)
        )
        head = self._first_available(row, "MODFLOW_Head", default=self.feature_defaults.get("MODFLOW_Head", 0.0))
        k = self._first_available(row, "K", default=self.feature_defaults.get("K", 0.0))
        rain = self._first_available(
            row,
            "AverageRainfall",
            "Average_Rainfall",
            "Rainfall",
            default=self.feature_defaults.get("AverageRainfall", 0.0),
        )
        dist = self._first_available(
            row,
            "Distance_To_Waterbody",
            "Distance_to_water",
            default=self.feature_defaults.get("Distance_To_Waterbody", 0.0),
        )
        ndvi = self._first_available(row, "NDVI", "ndvi", default=self.feature_defaults.get("NDVI", 0.0))
        drill = self._first_available(
            row,
            "Total_Drilling_Depth",
            "Drilling_Depth",
            default=self.feature_defaults.get("Total_Drilling_Depth", 0.0),
        )
        casing = self._first_available(
            row,
            "Total_Casing_Depth",
            "Casing_Depth",
            default=self.feature_defaults.get("Total_Casing_Depth", 0.0),
        )

        row.update(
            {
                "UTME": utme,
                "UTMN": utmn,
                "Slope_Value": slope,
                "AverageRainfall": rain,
                "Distance_To_Waterbody": dist,
                "NDVI": ndvi,
                "Total_Drilling_Depth": drill,
                "Total_Casing_Depth": casing,
                "MODFLOW_Head": head,
                "K": k,
                "UTME_x_UTMN": utme * utmn,
                "Elevation_x_Slope": elevation * slope,
                "Head_x_K": head * k,
                "Casing_Drill_Ratio": (casing / drill) if (drill not in [0, None] and not pd.isna(drill)) else 0.0,
                "log_K": float(np.log1p(max(k, 0.0))),
                "log_AverageRainfall": float(np.log1p(max(rain, 0.0))),
                "log_Distance": float(np.log1p(max(dist, 0.0))),
                "NDVI_x_Rain": ndvi * rain,
            }
        )

        processed = pd.DataFrame(0.0, index=[0], columns=self.FEAT_COLS)

        for col in self.NUM_FEATS:
            if col in processed.columns:
                processed.loc[0, col] = pd.to_numeric(row.get(col, self.feature_defaults.get(col, 0.0)), errors="coerce")

        for cat_feat in self.CAT_FEATS:
            val = row.get(cat_feat, None)
            if val is not None and pd.notna(val):
                ohe_col = f"{cat_feat}_{val}"
                if ohe_col in processed.columns:
                    processed.loc[0, ohe_col] = 1.0

        return processed.reindex(columns=self.FEAT_COLS, fill_value=0.0).astype(float)

    # -----------------------
    # Prediction
    # -----------------------
    @staticmethod
    def _norm01(val: float, mn: float, mx: float) -> float:
        if val is None or mn is None or mx is None:
            return 0.0
        if abs(mx - mn) < 1e-12:
            return 0.0
        return float((val - mn) / (mx - mn + 1e-12))

    def _nearest_background_row(self, utme: float, utmn: float) -> Tuple[pd.Series, float]:
        point = np.array([float(utme), float(utmn)], dtype=float)
        if self.background_tree is not None:
            distance, idx = self.background_tree.query(point)
        else:
            distances = np.sqrt(((self.background_xy - point) ** 2).sum(axis=1))
            idx = int(np.argmin(distances))
            distance = float(distances[idx])
        return self.background_df.iloc[int(idx)].copy(), float(distance)

    def _classify_gpi(self, gpi: float) -> str:
        if gpi <= float(self.target_ranges.get("gpi_q25", 33.0)):
            return "Low"
        if gpi <= float(self.target_ranges.get("gpi_q75", 67.0)):
            return "Medium"
        return "High"

    @staticmethod
    def _decision_from_suitability(suitability: str) -> str:
        if suitability == "High":
            return "Suitable"
        if suitability == "Medium":
            return "Moderate"
        return "Not suitable"

    @staticmethod
    def _recommendation(suitability: str) -> str:
        if suitability == "High":
            return "Suitable for borehole siting"
        if suitability == "Medium":
            return "Moderate: verify with field investigation"
        return "Low priority for borehole siting"

    def predict_one_utm(self, utme: float, utmn: float) -> Dict[str, Any]:
        row, distance = self._nearest_background_row(utme, utmn)
        raw = row.to_dict()
        raw["UTME"], raw["UTMN"] = float(utme), float(utmn)

        X = self._prepare_model_features(raw)[self.FEAT_COLS].values
        pred_swl = float(self.model_swl.predict(X)[0])
        pred_yield = float(self.model_yield.predict(X)[0])

        pred_swl = float(np.clip(pred_swl, self.target_ranges["swl_min"], self.target_ranges["swl_max"]))
        pred_yield = float(np.clip(pred_yield, self.target_ranges["yield_min"], self.target_ranges["yield_max"]))

        head = float(raw.get("MODFLOW_Head", self.feature_defaults.get("MODFLOW_Head", 0.0)))
        k = float(raw.get("K", self.feature_defaults.get("K", 0.0)))

        gpi_raw = (
            0.35 * self._norm01(pred_yield, self.target_ranges["yield_min"], self.target_ranges["yield_max"])
            + 0.30 * (1 - self._norm01(pred_swl, self.target_ranges["swl_min"], self.target_ranges["swl_max"]))
            + 0.20 * self._norm01(head, self.target_ranges["head_min"], self.target_ranges["head_max"])
            + 0.15 * self._norm01(math.log1p(max(k, 0.0)), self.target_ranges["logk_min"], self.target_ranges["logk_max"])
        )
        gpi = round(float(np.clip(gpi_raw, 0.0, 1.0) * 100.0), 3)

        suitability = self._classify_gpi(gpi)
        decision = self._decision_from_suitability(suitability)
        lon, lat = self.utm36_to_geo(float(utme), float(utmn))

        return {
            "utme": float(utme),
            "utmn": float(utmn),
            "longitude": float(lon),
            "latitude": float(lat),
            "predicted_yield_m3h": float(pred_yield),
            "predicted_static_water_level_m": float(pred_swl),
            "gpi": float(gpi),
            "suitability_class": suitability,  # Low / Medium / High
            "decision": decision,  # Suitable / Moderate / Not suitable
            "recommendation": self._recommendation(suitability),
            "nearest_background_distance_m": float(distance),
        }

