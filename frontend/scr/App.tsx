import './App.css'
import { useMemo, useState } from 'react'
import { predict, type PredictResult } from './api'
import { MapPreview } from './components/MapPreview'
import { Charts } from './components/Charts'

function App() {
  const [utme, setUtme] = useState('520000')
  const [utmn, setUtmn] = useState('180000')
  const [batchPairs, setBatchPairs] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PredictResult[] | null>(null)
  const [status, setStatus] = useState<'idle' | 'online' | 'offline'>('idle')

  const best = useMemo(() => (results && results.length ? results[0] : null), [results])

  const decisionClass =
    best?.decision === 'Suitable' ? 'good' : best?.decision === 'Moderate' ? 'warn' : best ? 'bad' : 'muted'

  async function onPredictManual() {
    setError(null)
    setLoading(true)
    try {
      if (batchPairs.trim()) {
        const points = batchPairs
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const parts = l.split(/[,\s]+/).filter(Boolean)
            if (parts.length < 2) throw new Error(`Invalid line: "${l}". Use "UTME,UTMN"`)
            const e = Number(parts[0])
            const n = Number(parts[1])
            if (!Number.isFinite(e) || !Number.isFinite(n)) throw new Error(`Invalid numbers in line: "${l}"`)
            return { utme: e, utmn: n }
          })

        const resp = await predict({ source: 'manual', points_utm: points })
        setResults(resp.results)
        return
      }

      const e = Number(utme)
      const n = Number(utmn)
      if (!Number.isFinite(e) || !Number.isFinite(n)) throw new Error('Please enter valid numeric UTME and UTMN.')
      const resp = await predict({ source: 'manual', point_utm: { utme: e, utmn: n } })
      setResults(resp.results)
      setStatus('online')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('offline')
    } finally {
      setLoading(false)
    }
  }

  async function onUseMyLocation() {
    setError(null)
    setLoading(true)
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 })
      })
      const longitude = pos.coords.longitude
      const latitude = pos.coords.latitude

      const resp = await predict({ source: 'geolocation', point_geo: { longitude, latitude } })
      setResults(resp.results)
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setStatus('online')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('offline')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="heroTop">
          <div>
            <div className="title">BoreHole Sitter</div>
            <div className="subtitle">UTM Zone 36N · MapTiler Satellite · Trained model predictions</div>
          </div>
          <div className={`status ${status}`}>{status === 'idle' ? 'Ready' : status === 'online' ? 'Online' : 'Offline'}</div>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>Inputs</h2>

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
            <button className="btn primary" onClick={onPredictManual} disabled={loading}>
              {loading ? 'Predicting…' : 'Predict suitability'}
            </button>
          </div>

          <details className="details">
            <summary>Batch mode (for charts)</summary>
            <div className="hint">
              Paste multiple lines in the format <code>UTME,UTMN</code> (one point per line). When you run prediction,
              the app will rank the points and show charts.
            </div>
            <textarea
              value={batchPairs}
              onChange={(e) => setBatchPairs(e.target.value)}
              placeholder={'520000,180000\n520250,180250\n520500,180500'}
              rows={6}
            />
          </details>

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

        <section className="card wide">
          <h2>Charts</h2>
          {results && results.length > 1 ? (
            <Charts results={results} />
          ) : (
            <div className="muted">Charts appear automatically when you run batch mode (2+ points).</div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
