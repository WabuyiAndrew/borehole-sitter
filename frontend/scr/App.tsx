import './App.css'
import { useMemo, useState } from 'react'
import { predict, type PredictResult } from './api'
import { MapPreview } from './components/MapPreview'

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
        </section>

        <section className="card">
          <h2>Result</h2>
          {!best ? (
            <div className="muted">No prediction yet.</div>
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

              <div style={{ marginTop: 12 }}>
                <MapPreview
                  latitude={best.latitude}
                  longitude={best.longitude}
                  label={`${best.decision} · Yield ${best.predicted_yield_m3h.toFixed(2)} m³/h · GPI ${best.gpi.toFixed(1)}`}
                />
              </div>
            </>
          )}
        </section>

      </main>
    </div>
  )
}

export default App
