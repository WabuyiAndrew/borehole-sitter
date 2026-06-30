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

export type AuthResponse = {
  access_token: string
  token_type: 'bearer'
}

export type HealthResponse = {
  ok: boolean
  model_loaded: boolean
  model_status?: 'ready' | 'loading' | 'starting' | 'error'
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
const AUTH_LOGIN_URL = `${API_BASE_URL}/auth/login`
const AUTH_SIGNUP_URL = `${API_BASE_URL}/auth/signup`
const REPORT_PDF_URL = `${API_BASE_URL}/report/pdf`

const TOKEN_KEY = 'drillscout_auth_token'
const SESSION_KEY = 'drillscout_auth_session'
let authTokenMemory: string | null = null

async function readErrorMessage(res: Response) {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = (await res.json().catch(() => null)) as
      | { detail?: string | Array<{ msg?: string; loc?: Array<string | number> }>; message?: string }
      | null
    if (Array.isArray(data?.detail) && data.detail.length) {
      return data.detail
        .map((item) => {
          const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : ''
          const prefix = typeof field === 'string' && field ? `${field}: ` : ''
          return `${prefix}${String(item.msg || 'Invalid value')}`
        })
        .join('. ')
    }
    if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail
    if (typeof data?.message === 'string' && data.message.trim()) return data.message
  }

  const text = await res.text().catch(() => '')
  return text.trim() || `Request failed with status ${res.status}`
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = () => controller.abort()
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
      if (signal?.aborted && !timedOut) {
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

function clearPersistedAuth() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(TOKEN_KEY)
  window.localStorage.removeItem(SESSION_KEY)
}

function shouldRetryServiceError(err: unknown) {
  if (!(err instanceof Error)) return false
  return /Model is warming up|temporarily unavailable|Request failed with status 503|Request failed with status 502/i.test(err.message)
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener('abort', abortListener)
      resolve()
    }, ms)
    const abortListener = () => {
      window.clearTimeout(timeoutId)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abortListener, { once: true })
  })
}

async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retryDelaysMs: number[],
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await fetchJson<T>(url, init, timeoutMs, signal)
    } catch (err) {
      lastError = err
      if (!shouldRetryServiceError(err) || attempt === retryDelaysMs.length) {
        throw err
      }
      await wait(retryDelaysMs[attempt], signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The service is temporarily unavailable. Please try again.')
}

export function getApiBaseUrl() {
  return API_BASE_URL
}

export function getAuthToken() {
  clearPersistedAuth()
  return authTokenMemory && authTokenMemory.trim() ? authTokenMemory : null
}

export function setAuthToken(token: string | null) {
  authTokenMemory = token && token.trim() ? token : null
  clearPersistedAuth()
}

function buildAuthHeaders(headers: Record<string, string> = {}) {
  const token = getAuthToken()
  if (!token) return headers
  return { ...headers, Authorization: `Bearer ${token}` }
}

export async function warmBackend() {
  try {
    return await fetchJson<HealthResponse>(HEALTH_URL, { method: 'GET' }, 15000)
  } catch {
    return null
  }
}

export async function login(email: string, password: string) {
  const res = await fetchJson<AuthResponse>(
    AUTH_LOGIN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    45000,
  )
  setAuthToken(res.access_token)
  return res
}

export async function signup(email: string, password: string) {
  return fetchJson<AuthResponse>(
    AUTH_SIGNUP_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    45000,
  )
}

export async function predict(req: PredictRequest): Promise<PredictResponse> {
  return fetchJsonWithRetry<PredictResponse>(
    PREDICT_URL,
    {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req),
    },
    90000,
    [2000, 4000, 8000, 12000, 16000],
  )
}

export async function convertCoordinates(
  req: ConvertCoordinatesRequest,
  signal?: AbortSignal,
): Promise<ConvertCoordinatesResponse> {
  return fetchJsonWithRetry<ConvertCoordinatesResponse>(
    CONVERT_COORDINATES_URL,
    {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req),
    },
    45000,
    [1200, 2500],
    signal,
  )
}

export async function fetchReportPdf(payload: unknown) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 60000)
  try {
    const res = await fetch(REPORT_PDF_URL, {
      method: 'POST',
      headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      const message = await readErrorMessage(res)
      throw new Error(message)
    }
    return await res.blob()
  } finally {
    window.clearTimeout(timeoutId)
  }
}
