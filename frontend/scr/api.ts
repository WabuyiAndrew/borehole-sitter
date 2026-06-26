export type PredictRequest =
  | {
      source: 'manual'
      point_utm: { utme: number; utmn: number }
    }
  | {
      source: 'geolocation'
      point_geo: { longitude: number; latitude: number }
    }
  | {
      source: 'manual'
      points_utm: { utme: number; utmn: number }[]
    }

export type PredictResult = {
  utme: number
  utmn: number
  longitude: number
  latitude: number
  predicted_yield_m3h: number
  predicted_static_water_level_m: number
  gpi: number
  suitability_class: 'Low' | 'Medium' | 'High'
  decision: 'Suitable' | 'Moderate' | 'Not suitable'
  recommendation: string
  nearest_background_distance_m: number
}

export type PredictResponse = {
  best: PredictResult
  results: PredictResult[]
  warnings: string[]
  bundle_version: string
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

export async function predict(req: PredictRequest): Promise<PredictResponse> {
  const res = await fetch(`${API_BASE_URL}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Prediction failed (${res.status})`)
  }
  return res.json()
}

