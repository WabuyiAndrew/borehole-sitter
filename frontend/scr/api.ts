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

const DEFAULT_BACKEND_URL = 'https://borehole-sitter.onrender.com'

function resolveApiBaseUrl() {
  const envBase = String(import.meta.env.VITE_API_BASE_URL || '').trim()
  if (envBase) return envBase.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    if (protocol === 'capacitor:' || protocol === 'ionic:') {
      return 'http://10.0.2.2:8000'
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return 'http://localhost:8000'
    }
    return DEFAULT_BACKEND_URL
  }
  return DEFAULT_BACKEND_URL
}

const API_BASE_URL = resolveApiBaseUrl()
const PREDICT_URL = `${API_BASE_URL}/predict`
const HEALTH_URL = `${API_BASE_URL}/health`

async function readErrorMessage(res: Response) {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = (await res.json().catch(() => null)) as { detail?: string; message?: string } | null
    if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail
    if (typeof data?.message === 'string' && data.message.trim()) return data.message
  }

  const text = await res.text().catch(() => '')
  return text.trim() || `Request failed with status ${res.status}`
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
    })

    if (!res.ok) {
      const message = await readErrorMessage(res)
      throw new Error(message)
    }

    return (await res.json()) as T
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`The prediction service is taking too long to respond at ${url}. It may be waking up from a cold start.`)
    }

    if (err instanceof TypeError) {
      throw new Error(
        `Unable to reach the prediction service at ${url}. Please make sure the backend is running, CORS is enabled for this app origin, and the API base URL is correct. (${err.message})`,
      )
    }

    throw err
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export function getApiBaseUrl() {
  return API_BASE_URL
}

export async function warmBackend() {
  try {
    await fetchJson<{ ok: boolean }>(HEALTH_URL, { method: 'GET' }, 45000)
    return true
  } catch {
    return false
  }
}

export async function predict(req: PredictRequest): Promise<PredictResponse> {
  return fetchJson<PredictResponse>(
    PREDICT_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    },
    60000,
  )
}
