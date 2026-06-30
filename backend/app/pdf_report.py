from __future__ import annotations

from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

import requests
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def _static_map_url(latitude: float, longitude: float) -> str:
    base = "https://staticmap.openstreetmap.de/staticmap.php"
    return (
        f"{base}?center={latitude:.6f},{longitude:.6f}"
        f"&zoom=14&size=640x360&markers={latitude:.6f},{longitude:.6f},red-pushpin"
    )


def _fetch_map_png(latitude: float, longitude: float) -> Optional[bytes]:
    try:
        res = requests.get(_static_map_url(latitude, longitude), timeout=15)
        if res.ok and res.content:
            return res.content
    except Exception:
        return None
    return None


def _fmt(value: Any, digits: int = 5) -> str:
    if isinstance(value, (int, float)):
        return f"{float(value):.{digits}f}"
    return str(value)


def build_pdf_report(
    title: str,
    point: Tuple[float, float],
    best: Dict[str, Any],
    results: List[Dict[str, Any]],
    place_name: Optional[str] = None,
    place_details: Optional[str] = None,
) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, title=title)
    styles = getSampleStyleSheet()

    story: list[Any] = []
    story.append(Paragraph(title, styles["Title"]))
    if place_name:
        story.append(Paragraph(place_name, styles["Heading2"]))
    if place_details:
        story.append(Paragraph(place_details, styles["BodyText"]))
    story.append(Spacer(1, 10))

    lat, lon = point
    map_png = _fetch_map_png(lat, lon)
    if map_png:
        img = Image(BytesIO(map_png))
        img.drawWidth = 520
        img.drawHeight = 292
        story.append(img)
        story.append(Spacer(1, 12))

    best_rows = [
        ["Latitude", _fmt(best.get("latitude"))],
        ["Longitude", _fmt(best.get("longitude"))],
        ["UTME", _fmt(best.get("utme"), 2)],
        ["UTMN", _fmt(best.get("utmn"), 2)],
        ["GPI", _fmt(best.get("gpi"), 2)],
        ["Yield (m³/h)", _fmt(best.get("predicted_yield_m3h"), 2)],
        ["SWL (m)", _fmt(best.get("predicted_static_water_level_m"), 2)],
        ["Decision", str(best.get("decision") or "")],
        ["Class", str(best.get("suitability_class") or "")],
    ]
    best_table = Table(best_rows, colWidths=[150, 360])
    best_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#e5e7eb")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.HexColor("#f3f4f6")]),
            ]
        )
    )
    story.append(Paragraph("Selected point summary", styles["Heading3"]))
    story.append(best_table)
    story.append(Spacer(1, 14))

    top = results[: min(len(results), 20)]
    header = ["Rank", "GPI", "Yield", "SWL", "Decision"]
    rows = [header]
    for i, r in enumerate(top, start=1):
        rows.append(
            [
                str(i),
                _fmt(r.get("gpi"), 2),
                _fmt(r.get("predicted_yield_m3h"), 2),
                _fmt(r.get("predicted_static_water_level_m"), 2),
                str(r.get("decision") or ""),
            ]
        )
    results_table = Table(rows, colWidths=[45, 80, 120, 110, 155])
    results_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#111827")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story.append(Paragraph("Top predictions", styles["Heading3"]))
    story.append(results_table)

    doc.build(story)
    return buffer.getvalue()
