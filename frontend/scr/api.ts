export type PredictRequest =
  | {
      source: 'manual'
      point_utm: { utme: number; utmn: number }
    }
  | {
      source: 'manual'
      point_geo: { longitude: number; latitude: number }
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

export type CoordinateReference = {
  utme: number
  utmn: number
  longitude: number
  latitude: number
  zone: number
  northern: boolean
  epsg: number
}

export type ConvertCoordinatesRequest =
  | {
      point_geo: { longitude: number; latitude: number }
    }
  | {
      point_utm: { utme: number; utmn: number; zone?: number; northern?: boolean }
    }

export type ConvertCoordinatesResponse = {
  input_mode: 'geo' | 'utm'
  authoritative: CoordinateReference
  model: CoordinateReference
}

export type ReverseGeocodeResponse = {
  title: string
  full_label: string
  resolved: boolean
}

const DEFAULT_BACKEND_URL = 'https://borehole-sitter.onrender.com'

function resolveApiBaseUrl() {
  const envBase = String(import.meta.env.VITE_API_BASE_URL || '').trim()
  if (envBase) return envBase.replace(/\/$/, '')
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location
    if (protocol === 'capacitor:' || protocol === 'ionic:') {
      return DEFAULT_BACKEND_URL
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
const CONVERT_COORDINATES_URL = `${API_BASE_URL}/convert-coordinates`
const REVERSE_GEOCODE_URL = `${API_BASE_URL}/reverse-geocode`

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

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  let abortedByCaller = false
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = () => {
    abortedByCaller = true
    controller.abort()
  }
  signal?.addEventListener('abort', abortFromCaller)

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
      if (abortedByCaller && !timedOut) {
        throw err
      }
      throw new Error('The service is taking longer than expected to respond. Please wait a moment and try again.')
    }

    if (err instanceof TypeError) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('No internet connection detected. Check your network and try again.')
      }
      throw new Error('We could not reach the service right now. Check your internet connection and try again.')
    }

    throw err
  } finally {
    window.clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
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

export async function convertCoordinates(
  req: ConvertCoordinatesRequest,
  signal?: AbortSignal,
): Promise<ConvertCoordinatesResponse> {
  return fetchJson<ConvertCoordinatesResponse>(
    CONVERT_COORDINATES_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    },
    45000,
    signal,
  )
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<ReverseGeocodeResponse> {
  const url = new URL(REVERSE_GEOCODE_URL)
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  return fetchJson<ReverseGeocodeResponse>(
    url.toString(),
    {
      method: 'GET',
    },
    20000,
    signal,
  )
}
