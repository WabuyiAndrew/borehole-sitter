import './App.css'
import { useMemo, useState } from 'react'
import { predict, type PredictResult } from './api'
import { MapPreview } from './components/MapPreview'

type LatLng = {
  latitude: number
  longitude: number
}

const DEFAULT_LOCATION: LatLng = {
  latitude: 0.55,
  longitude: 36.80,
}

const WGS84_A = 6378137.0
const WGS84_ECCSQ = 0.006694379990141316
const K0 = 0.9996

function degToRad(value: number) {
  return (value * Math.PI) / 180
}

function radToDeg(value: number) {
  return (value * 180) / Math.PI
}

function latLonToUtm(latitude: number, longitude: number, zone = 36) {
  const latRad = degToRad(latitude)
  const lonRad = degToRad(longitude)
  const lonOrigin = degToRad(zone * 6 - 183)

  const eccPrimeSq = WGS84_ECCSQ / (1 - WGS84_ECCSQ)
  const N = WGS84_A / Math.sqrt(1 - WGS84_ECCSQ * Math.sin(latRad) ** 2)
  const T = Math.tan(latRad) ** 2
  const C = eccPrimeSq * Math.cos(latRad) ** 2
  const A = Math.cos(latRad) * (lonRad - lonOrigin)

  const M =
    WGS84_A *
    ((1 - WGS84_ECCSQ / 4 - (3 * WGS84_ECCSQ ** 2) / 64 - (5 * WGS84_ECCSQ ** 3) / 256) * latRad -
      ((3 * WGS84_ECCSQ) / 8 + (3 * WGS84_ECCSQ ** 2) / 32 + (45 * WGS84_ECCSQ ** 3) / 1024) * Math.sin(2 * latRad) +
      ((15 * WGS84_ECCSQ ** 2) / 256 + (45 * WGS84_ECCSQ ** 3) / 1024) * Math.sin(4 * latRad) -
      ((35 * WGS84_ECCSQ ** 3) / 3072) * Math.sin(6 * latRad))

  const utme =
    K0 * N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T ** 2 + 72 * C - 58 * eccPrimeSq) * A ** 5) / 120) +
    500000

  const utmn =
    K0 *
      (M +
        N * Math.tan(latRad) *
          ((A ** 2) / 2 +
            ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
            ((61 - 58 * T + T ** 2 + 600 * C - 330 * eccPrimeSq) * A ** 6) / 720))

  return { utme, utmn }
}

function utmToLatLon(utme: number, utmn: number, zone = 36, northern = true): LatLng {
  let x = utme - 500000
  let y = utmn
  if (!northern) y -= 10000000

  const eccPrimeSq = WGS84_ECCSQ / (1 - WGS84_ECCSQ)
  const M = y / K0
  const mu =
    M /
    (WGS84_A *
      (1 - WGS84_ECCSQ / 4 - (3 * WGS84_ECCSQ ** 2) / 64 - (5 * WGS84_ECCSQ ** 3) / 256))

  const e1 = (1 - Math.sqrt(1 - WGS84_ECCSQ)) / (1 + Math.sqrt(1 - WGS84_ECCSQ))
  const J1 = (3 * e1) / 2 - (27 * e1 ** 3) / 32
  const J2 = (21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32
  const J3 = (151 * e1 ** 3) / 96
  const J4 = (1097 * e1 ** 4) / 512

  const fp =
    mu +
    J1 * Math.sin(2 * mu) +
    J2 * Math.sin(4 * mu) +
    J3 * Math.sin(6 * mu) +
    J4 * Math.sin(8 * mu)

  const sinFp = Math.sin(fp)
  const cosFp = Math.cos(fp)
  const tanFp = Math.tan(fp)

  const C1 = eccPrimeSq * cosFp ** 2
  const T1 = tanFp ** 2
  const R1 = (WGS84_A * (1 - WGS84_ECCSQ)) / ((1 - WGS84_ECCSQ * sinFp ** 2) ** 1.5)
  const N1 = WGS84_A / Math.sqrt(1 - WGS84_ECCSQ * sinFp ** 2)
  const D = x / (N1 * K0)

  const lat =
    fp -
    (N1 * tanFp / R1) *
      ((D ** 2) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * eccPrimeSq) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * eccPrimeSq - 3 * C1 ** 2) * D ** 6) / 720)

  const lonOrigin = degToRad(zone * 6 - 183)
  const lon =
    lonOrigin +
    (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * eccPrimeSq + 24 * T1 ** 2) * D ** 5) / 120) /
      cosFp

  return { latitude: radToDeg(lat), longitude: radToDeg(lon) }
}

function App() {
  const [utme, setUtme] = useState('520000')
  const [utmn, setUtmn] = useState('180000')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PredictResult[] | null>(null)
  const [status, setStatus] = useState<'ready' | 'connected' | 'error'>('ready')

  const best = useMemo(() => (results && results.length ? results[0] : null), [results])

  const manualUtme = Number(utme)
  const manualUtmn = Number(utmn)
  const hasValidManual = Number.isFinite(manualUtme) && Number.isFinite(manualUtmn)
  const canPredict = !loading && hasValidManual

  const decisionClass =
    best?.decision === 'Suitable' ? 'good' : best?.decision === 'Moderate' ? 'warn' : best ? 'bad' : 'muted'

  const mapCenter = useMemo(() => {
    if (best) return { latitude: best.latitude, longitude: best.longitude }
    if (hasValidManual) return utmToLatLon(manualUtme, manualUtmn)
    return DEFAULT_LOCATION
  }, [best, hasValidManual, manualUtme, manualUtmn])

  function formatRuntimeError(err: unknown) {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    if (typeof err === 'object' && err !== null) {
      const maybe = err as Record<string, unknown>
      if (typeof maybe.message === 'string') return maybe.message
      if ('code' in maybe) return `Error ${String(maybe.code)}: ${String(maybe.message ?? 'Location not available')}`
    }
    return String(err)
  }

  async function onPredictManual() {
    setError(null)
    setLoading(true)
    try {
      const e = Number(utme)
      const n = Number(utmn)
      if (!Number.isFinite(e) || !Number.isFinite(n)) throw new Error('Please enter valid numeric UTME and UTMN.')
      const resp = await predict({ source: 'manual', point_utm: { utme: e, utmn: n } })
      setResults(resp.results)
      setStatus('connected')
    } catch (err) {
      setError(formatRuntimeError(err))
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  async function onUseMyLocation() {
    setError(null)
    setLoading(true)
    try {
      if (!navigator.geolocation) {
        throw new Error('Geolocation is unavailable in this browser or app environment.')
      }
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 })
      })
      const longitude = pos.coords.longitude
      const latitude = pos.coords.latitude

      const resp = await predict({ source: 'geolocation', point_geo: { longitude, latitude } })
      setResults(resp.results)
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setStatus('connected')
    } catch (err) {
      setError(formatRuntimeError(err))
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  function handleMapClick(latitude: number, longitude: number) {
    const utm = latLonToUtm(latitude, longitude)
    setUtme(String(Math.round(utm.utme)))
    setUtmn(String(Math.round(utm.utmn)))
    setError(null)
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="heroTop">
          <div>
            <div className="title">DrillScout</div>
            <div className="subtitle">Predict the best borehole siting location from coordinates or your current position.</div>
          </div>
          <div className={`status ${status}`}>{status === 'ready' ? 'Ready' : status === 'connected' ? 'Connected' : 'Error'}</div>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>Coordinates</h2>

          <div className="row">
            <label>
              <div className="label">UTME (m)</div>
              <input value={utme} onChange={(e) => setUtme(e.target.value)} inputMode="decimal" />
            </label>
            <label>
              <div className="label">UTMN (m)</div>
              <input value={utmn} onChange={(e) => setUtmn(e.target.value)} inputMode="decimal" />
            </label>
          </div>

          <div className="buttons">
            <button className="btn" onClick={onUseMyLocation} disabled={loading}>
              Use my location
            </button>
            <button className="btn primary" onClick={onPredictManual} disabled={!canPredict}>
              {loading ? 'Predicting…' : 'Predict suitability'}
            </button>
          </div>

          {error ? <div className="error">{error}</div> : null}
          <p className="hint">Click the map to choose a point and automatically fill UTME/UTMN.</p>
        </section>

        <section className="card">
          <h2>Site preview</h2>

          <MapPreview
            latitude={mapCenter.latitude}
            longitude={mapCenter.longitude}
            label={best ? `${best.decision} · Yield ${best.predicted_yield_m3h.toFixed(2)} m³/h · GPI ${best.gpi.toFixed(1)}` : 'Current selection'}
            onMapClick={handleMapClick}
          />

          <div className="resultPanel">
            {!best ? (
              <div className="muted">No prediction yet. Click the map or use your location to choose a point.</div>
            ) : (
              <>
                <div className="resultTop">
                  <div className={`badge ${decisionClass}`}>{best.decision}</div>
                  <div className="muted">
                    GPI <b>{best.gpi.toFixed(2)}</b> · Yield <b>{best.predicted_yield_m3h.toFixed(2)} m³/h</b> · SWL{' '}
                    <b>{best.predicted_static_water_level_m.toFixed(2)} m</b>
                  </div>
                  <div className="muted">{best.recommendation}</div>
                </div>
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
