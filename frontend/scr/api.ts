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

function resolveApiBaseUrl() {
  const envBase = String(import.meta.env.VITE_API_BASE_URL || '').trim()
  if (envBase) return envBase.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location
    if (protocol === 'capacitor:' || protocol === 'ionic:') {
      // Capacitor Android emulator uses 10.0.2.2 to reach host machine localhost.
      return 'http://10.0.2.2:8000'
    }
    if (protocol === 'tauri:' || protocol === 'file:') {
      // Desktop packages and local file loads should use the desktop host's localhost.
      return 'http://localhost:8000'
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:8000'
    }
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`
  }
  return 'http://localhost:8000'
}

const API_BASE_URL = resolveApiBaseUrl()
const API_URL = `${API_BASE_URL}/predict`

export async function predict(req: PredictRequest): Promise<PredictResponse> {
  try {
    const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(txt || `Prediction failed (${res.status})`)
    }
    return res.json()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Unable to reach the prediction service at ${API_URL}. Please make sure the backend is running and the API base URL is correct. (${message})`,
    )
  }
}

