import './App.css'
import { useEffect, useMemo, useState } from 'react'
import proj4 from 'proj4'
import { getApiBaseUrl, predict, type PredictResult, warmBackend } from './api'
import { Charts } from './components/Charts'
import { MapPreview } from './components/MapPreview'

type LatLng = {
  latitude: number
  longitude: number
}

type BatchPoint = {
  utme: number
  utmn: number
}

type UtmPoint = {
  utme: number
  utmn: number
}

type PlaceLookup = {
  title: string
  fullLabel: string
}

type InputMode = 'geo' | 'utm'

const DEFAULT_LOCATION: LatLng = {
  latitude: 0.55,
  longitude: 36.80,
}

const DEFAULT_BATCH_INPUT = ['520000,180000', '520250,180250', '520500,180500'].join('\n')
const UTM_36N = '+proj=utm +zone=36 +datum=WGS84 +units=m +no_defs'

function parseCoordinate(value: string) {
  const normalized = value.trim().replace(',', '.')
  if (!normalized) return null
  const numeric = Number(normalized)
  return Number.isFinite(numeric) ? numeric : null
}

function latLonToUtm(latitude: number, longitude: number): UtmPoint {
  const [utme, utmn] = proj4('EPSG:4326', UTM_36N, [longitude, latitude])
  return { utme: Number(utme), utmn: Number(utmn) }
}

function utmToLatLon(utme: number, utmn: number): LatLng {
  const [longitude, latitude] = proj4(UTM_36N, 'EPSG:4326', [utme, utmn])
  return { latitude: Number(latitude), longitude: Number(longitude) }
}

function parseBatchInput(value: string): BatchPoint[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line, index) => {
    const parts = line
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter(Boolean)

    if (parts.length < 2) {
      throw new Error(`Line ${index + 1} must contain UTME and UTMN, for example: 520000,180000`)
    }

    const utme = Number(parts[0])
    const utmn = Number(parts[1])

    if (!Number.isFinite(utme) || !Number.isFinite(utmn)) {
      throw new Error(`Line ${index + 1} contains invalid numeric coordinates.`)
    }

    return { utme, utmn }
  })
}

function buildPlaceLookup(data: unknown, latitude: number, longitude: number): PlaceLookup | null {
  if (typeof data !== 'object' || data === null) return null

  const candidate = data as {
    display_name?: string
    address?: Record<string, string | undefined>
  }
  const address = candidate.address || {}
  const titleParts = [
    address.road,
    address.suburb,
    address.village,
    address.town,
    address.city,
    address.county,
    address.state,
    address.country,
  ].filter(Boolean) as string[]

  const title = titleParts.slice(0, 3).join(', ')
  const fallback = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`

  return {
    title: title || candidate.display_name || fallback,
    fullLabel: candidate.display_name || title || fallback,
  }
}

async function reverseGeocodePoint(latitude: number, longitude: number, signal: AbortSignal): Promise<PlaceLookup | null> {
  const url = new URL('https://nominatim.openstreetmap.org/reverse')
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('lat', String(latitude))
  url.searchParams.set('lon', String(longitude))
  url.searchParams.set('zoom', '14')
  url.searchParams.set('addressdetails', '1')

  const response = await fetch(url.toString(), {
    method: 'GET',
    signal,
    headers: {
      Accept: 'application/json',
    },
  })

  if (!response.ok) return null

  const payload = (await response.json()) as unknown
  return buildPlaceLookup(payload, latitude, longitude)
}

function escapeCsvValue(value: string | number) {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(href)
}

async function getCurrentPosition(options: PositionOptions) {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options)
  })
}

async function getStableCurrentPosition() {
  const first = await getCurrentPosition({
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 15000,
  })

  const firstAccuracy = typeof first.coords.accuracy === 'number' ? first.coords.accuracy : Number.POSITIVE_INFINITY
  if (firstAccuracy <= 25) return first

  try {
    const second = await getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 0,
    })
    const secondAccuracy = typeof second.coords.accuracy === 'number' ? second.coords.accuracy : Number.POSITIVE_INFINITY
    return secondAccuracy < firstAccuracy ? second : first
  } catch {
    return first
  }
}

function App() {
  const [inputMode, setInputMode] = useState<InputMode>('geo')
  const [latitudeInput, setLatitudeInput] = useState('0.44747')
  const [longitudeInput, setLongitudeInput] = useState('32.33873')
  const [utme, setUtme] = useState('520000')
  const [utmn, setUtmn] = useState('180000')
  const [batchInput, setBatchInput] = useState(DEFAULT_BATCH_INPUT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PredictResult[] | null>(null)
  const [status, setStatus] = useState<'ready' | 'warming' | 'connected' | 'error'>('warming')
  const [selectedPoint, setSelectedPoint] = useState<LatLng | null>(null)
  const [locationSummary, setLocationSummary] = useState<string | null>(null)
  const [placeName, setPlaceName] = useState<string | null>(null)
  const [placeDetails, setPlaceDetails] = useState<string | null>(null)
  const [lookingUpPlace, setLookingUpPlace] = useState(false)

  const best = useMemo(() => (results && results.length ? results[0] : null), [results])

  const manualLatitude = parseCoordinate(latitudeInput)
  const manualLongitude = parseCoordinate(longitudeInput)
  const manualUtme = Number(utme)
  const manualUtmn = Number(utmn)

  const geoDraft = useMemo(() => {
    if (manualLatitude === null || manualLongitude === null) {
      return { valid: false as const, error: 'Enter both latitude and longitude.' }
    }
    if (manualLatitude < -90 || manualLatitude > 90) {
      return { valid: false as const, error: 'Latitude must be between -90 and 90.' }
    }
    if (manualLongitude < -180 || manualLongitude > 180) {
      return { valid: false as const, error: 'Longitude must be between -180 and 180.' }
    }
    const converted = latLonToUtm(manualLatitude, manualLongitude)
    return {
      valid: true as const,
      point: { latitude: manualLatitude, longitude: manualLongitude },
      utm: converted,
    }
  }, [manualLatitude, manualLongitude])

  const utmDraft = useMemo(() => {
    if (!Number.isFinite(manualUtme) || !Number.isFinite(manualUtmn)) {
      return { valid: false as const, error: 'Enter both UTME and UTMN.' }
    }
    const point = utmToLatLon(manualUtme, manualUtmn)
    if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
      return { valid: false as const, error: 'These UTM coordinates could not be converted.' }
    }
    return {
      valid: true as const,
      point,
      utm: { utme: manualUtme, utmn: manualUtmn },
    }
  }, [manualUtme, manualUtmn])

  const activeDraft = inputMode === 'geo' ? geoDraft : utmDraft
  const canPredict = !loading && activeDraft.valid

  const decisionClass =
    best?.decision === 'Suitable' ? 'good' : best?.decision === 'Moderate' ? 'warn' : best ? 'bad' : 'muted'

  const draftPoint = activeDraft.valid ? activeDraft.point : null
  const mapCenter = useMemo(() => {
    if (selectedPoint) return selectedPoint
    if (draftPoint) return draftPoint
    return DEFAULT_LOCATION
  }, [selectedPoint, draftPoint])
  const batchDraft = useMemo(() => {
    try {
      const points = parseBatchInput(batchInput)
      return { points, error: null as string | null }
    } catch (err) {
      return { points: [] as BatchPoint[], error: err instanceof Error ? err.message : String(err) }
    }
  }, [batchInput])

  const statusLabel =
    status === 'warming' ? 'Working' : status === 'ready' ? 'Ready' : status === 'connected' ? 'Connected' : 'Error'
  const syncedGeoPreview = geoDraft.valid
    ? `${geoDraft.point.latitude.toFixed(5)}, ${geoDraft.point.longitude.toFixed(5)}`
    : utmDraft.valid
      ? `${utmDraft.point.latitude.toFixed(5)}, ${utmDraft.point.longitude.toFixed(5)}`
      : 'Waiting for valid values'
  const syncedUtmPreview = geoDraft.valid
    ? `${geoDraft.utm.utme.toFixed(2)}, ${geoDraft.utm.utmn.toFixed(2)}`
    : utmDraft.valid
      ? `${utmDraft.utm.utme.toFixed(2)}, ${utmDraft.utm.utmn.toFixed(2)}`
      : 'Waiting for valid values'
  const markerLabel = best
    ? `${placeName ? `${placeName} · ` : ''}${best.decision} · Yield ${best.predicted_yield_m3h.toFixed(2)} m³/h · GPI ${best.gpi.toFixed(1)}`
    : `${placeName ? `${placeName} · ` : ''}Current selection`

  useEffect(() => {
    let active = true

    void warmBackend().then((ok) => {
      if (!active) return
      setStatus((current) => (current === 'connected' || current === 'error' ? current : ok ? 'ready' : 'ready'))
    })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const pointForLookup = selectedPoint ?? draftPoint

    if (!pointForLookup) {
      setPlaceName(null)
      setPlaceDetails(null)
      setLookingUpPlace(false)
      return
    }

    const controller = new AbortController()
    setLookingUpPlace(true)

    void reverseGeocodePoint(pointForLookup.latitude, pointForLookup.longitude, controller.signal)
      .then((place) => {
        if (!place) return
        setPlaceName(place.title)
        setPlaceDetails(place.fullLabel)
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setPlaceName(null)
        setPlaceDetails(null)
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLookingUpPlace(false)
        }
      })

    return () => {
      controller.abort()
    }
  }, [selectedPoint, draftPoint])

  function formatRuntimeError(err: unknown) {
    if (err instanceof Error) return err.message
    if (typeof err === 'string') return err
    if (typeof err === 'object' && err !== null) {
      const maybe = err as Record<string, unknown>
      if (typeof maybe.message === 'string') return maybe.message
      if ('code' in maybe) {
        const code = Number(maybe.code)
        if (code === 1) return 'Location permission was denied. Please allow location access and try again.'
        if (code === 2) return 'Your location could not be determined right now. Please try again outdoors or with GPS enabled.'
        if (code === 3) return 'Location detection took too long. Please try again.'
      }
    }
    return 'Something went wrong. Please try again.'
  }

  function resetSelectionState(summary: string) {
    setSelectedPoint(null)
    setPlaceName(null)
    setPlaceDetails(null)
    setResults(null)
    setLocationSummary(summary)
    setError(null)
    setStatus('ready')
  }

  function applyGeoValues(point: LatLng, summary: string) {
    const converted = latLonToUtm(point.latitude, point.longitude)
    setInputMode('geo')
    setLatitudeInput(point.latitude.toFixed(5))
    setLongitudeInput(point.longitude.toFixed(5))
    setUtme(String(Math.round(converted.utme)))
    setUtmn(String(Math.round(converted.utmn)))
    setSelectedPoint(point)
    setResults(null)
    setPlaceName(null)
    setPlaceDetails(null)
    setLocationSummary(summary)
    setError(null)
    setStatus('ready')
  }

  function applyUtmValues(point: UtmPoint, summary: string) {
    const converted = utmToLatLon(point.utme, point.utmn)
    setInputMode('utm')
    setUtme(String(Math.round(point.utme)))
    setUtmn(String(Math.round(point.utmn)))
    setLatitudeInput(converted.latitude.toFixed(5))
    setLongitudeInput(converted.longitude.toFixed(5))
    setSelectedPoint(converted)
    setResults(null)
    setPlaceName(null)
    setPlaceDetails(null)
    setLocationSummary(summary)
    setError(null)
    setStatus('ready')
  }

  function downloadResultsCsv() {
    if (!results?.length) return

    const header = [
      'rank',
      'utme',
      'utmn',
      'latitude',
      'longitude',
      'decision',
      'suitability_class',
      'gpi',
      'predicted_yield_m3h',
      'predicted_static_water_level_m',
      'nearest_background_distance_m',
      'recommendation',
    ]
    const rows = results.map((result, index) =>
      [
        index + 1,
        result.utme,
        result.utmn,
        result.latitude,
        result.longitude,
        result.decision,
        result.suitability_class,
        result.gpi,
        result.predicted_yield_m3h,
        result.predicted_static_water_level_m,
        result.nearest_background_distance_m,
        result.recommendation,
      ]
        .map(escapeCsvValue)
        .join(','),
    )

    downloadFile('drillscout-findings.csv', [header.join(','), ...rows].join('\n'), 'text/csv;charset=utf-8')
  }

  function downloadResultsReport() {
    if (!results?.length || !best) return

    const lines = [
      'DrillScout Findings Report',
      `Generated: ${new Date().toISOString()}`,
      `Place: ${placeDetails || placeName || 'Not resolved'}`,
      `API: ${getApiBaseUrl()}`,
      '',
      'Best candidate',
      `Decision: ${best.decision}`,
      `GPI: ${best.gpi.toFixed(2)}`,
      `Predicted yield: ${best.predicted_yield_m3h.toFixed(2)} m³/h`,
      `Predicted SWL: ${best.predicted_static_water_level_m.toFixed(2)} m`,
      `Coordinates: UTME ${best.utme.toFixed(2)}, UTMN ${best.utmn.toFixed(2)}`,
      `Latitude/Longitude: ${best.latitude.toFixed(5)}, ${best.longitude.toFixed(5)}`,
      `Recommendation: ${best.recommendation}`,
      '',
      'All evaluated points',
      ...results.map(
        (result, index) =>
          `${index + 1}. ${result.decision} | GPI ${result.gpi.toFixed(2)} | Yield ${result.predicted_yield_m3h.toFixed(2)} m³/h | SWL ${result.predicted_static_water_level_m.toFixed(2)} m | UTME ${result.utme.toFixed(2)} | UTMN ${result.utmn.toFixed(2)}`,
      ),
    ]

    downloadFile('drillscout-findings-report.txt', lines.join('\n'), 'text/plain;charset=utf-8')
  }

  async function onPredictManual() {
    setError(null)
    setLoading(true)
    setStatus('warming')
    try {
      if (!activeDraft.valid) {
        throw new Error(activeDraft.error)
      }

      const resp =
        inputMode === 'geo'
          ? await predict({
              source: 'geolocation',
              point_geo: { latitude: activeDraft.point.latitude, longitude: activeDraft.point.longitude },
            })
          : await predict({
              source: 'manual',
              point_utm: { utme: activeDraft.utm.utme, utmn: activeDraft.utm.utmn },
            })
      setResults(resp.results)
      setSelectedPoint({ latitude: resp.best.latitude, longitude: resp.best.longitude })
      setLatitudeInput(resp.best.latitude.toFixed(5))
      setLongitudeInput(resp.best.longitude.toFixed(5))
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setLocationSummary('Prediction completed. The map marker moved to the evaluated point.')
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
    setResults(null)
    setStatus('warming')
    try {
      if (!navigator.geolocation) {
        throw new Error('Location is not available on this device.')
      }
      const pos = await getStableCurrentPosition()
      const longitude = pos.coords.longitude
      const latitude = pos.coords.latitude
      const detectedUtm = latLonToUtm(latitude, longitude)

      setInputMode('geo')
      setSelectedPoint({ latitude, longitude })
      setLatitudeInput(latitude.toFixed(5))
      setLongitudeInput(longitude.toFixed(5))
      setUtme(String(Math.round(detectedUtm.utme)))
      setUtmn(String(Math.round(detectedUtm.utmn)))

      const accuracy =
        typeof pos.coords.accuracy === 'number' && Number.isFinite(pos.coords.accuracy)
          ? `accuracy about ${Math.round(pos.coords.accuracy)} m`
          : 'device GPS reading available'
      setLocationSummary(`Detected your current position with ${accuracy}.`)

      const resp = await predict({ source: 'geolocation', point_geo: { longitude, latitude } })
      setResults(resp.results)
      setSelectedPoint({ latitude: resp.best.latitude, longitude: resp.best.longitude })
      setLatitudeInput(resp.best.latitude.toFixed(5))
      setLongitudeInput(resp.best.longitude.toFixed(5))
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setLocationSummary(`Detected your position with ${accuracy}. The map marker moved to your location.`)
      setStatus('connected')
    } catch (err) {
      setError(formatRuntimeError(err))
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  async function onPredictBatch() {
    setError(null)
    setLoading(true)
    setStatus('warming')
    try {
      const points = parseBatchInput(batchInput)
      if (points.length < 2) {
        throw new Error('Enter at least two coordinate pairs in batch mode to render comparison charts.')
      }
      const resp = await predict({ source: 'manual', points_utm: points })
      setResults(resp.results)
      setSelectedPoint({ latitude: resp.best.latitude, longitude: resp.best.longitude })
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setLocationSummary(`Batch analysis completed for ${resp.results.length} points. The map centers on the best-ranked candidate.`)
      setStatus('connected')
    } catch (err) {
      setError(formatRuntimeError(err))
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  function handleMapClick(latitude: number, longitude: number) {
    applyGeoValues({ latitude, longitude }, 'Map selection updated. Run prediction to evaluate this point.')
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="heroTop">
          <div>
            <div className="title">DrillScout</div>
            <div className="subtitle">Predict the best borehole siting location from coordinates or your current position.</div>
          </div>
          <div className={`status ${status}`}>{statusLabel}</div>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>Coordinates</h2>

          <div className="modeSwitch" role="tablist" aria-label="Coordinate input mode">
            <button className={`modeBtn ${inputMode === 'geo' ? 'active' : ''}`} onClick={() => setInputMode('geo')} type="button">
              Latitude / Longitude
            </button>
            <button className={`modeBtn ${inputMode === 'utm' ? 'active' : ''}`} onClick={() => setInputMode('utm')} type="button">
              UTME / UTMN
            </button>
          </div>

          {inputMode === 'geo' ? (
            <div className="row">
              <label>
                <div className="label">Latitude</div>
                <input
                  value={latitudeInput}
                  onChange={(e) => {
                    setLatitudeInput(e.target.value)
                    resetSelectionState('Latitude updated manually.')
                  }}
                  inputMode="decimal"
                  placeholder="0.44747"
                />
              </label>
              <label>
                <div className="label">Longitude</div>
                <input
                  value={longitudeInput}
                  onChange={(e) => {
                    setLongitudeInput(e.target.value)
                    resetSelectionState('Longitude updated manually.')
                  }}
                  inputMode="decimal"
                  placeholder="32.33873"
                />
              </label>
            </div>
          ) : (
            <div className="row">
              <label>
                <div className="label">UTME (m)</div>
                <input
                  value={utme}
                  onChange={(e) => {
                    setUtme(e.target.value)
                    resetSelectionState('UTME updated manually.')
                  }}
                  inputMode="decimal"
                  placeholder="520000"
                />
              </label>
              <label>
                <div className="label">UTMN (m)</div>
                <input
                  value={utmn}
                  onChange={(e) => {
                    setUtmn(e.target.value)
                    resetSelectionState('UTMN updated manually.')
                  }}
                  inputMode="decimal"
                  placeholder="180000"
                />
              </label>
            </div>
          )}

          <div className="summaryGrid">
            <div className="summaryItem">
              <div className="label">Latitude / Longitude</div>
              <div className="summaryValue">{syncedGeoPreview}</div>
            </div>
            <div className="summaryItem">
              <div className="label">UTME / UTMN</div>
              <div className="summaryValue">{syncedUtmPreview}</div>
            </div>
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
          {!activeDraft.valid ? <div className="error">{activeDraft.error}</div> : null}
          <p className="hint">Click the map to choose a point. The app keeps latitude/longitude and UTM synchronized automatically.</p>
          <p className="hint">{locationSummary || 'Enter coordinates in the format you know best.'}</p>

          <details className="details">
            <summary>Batch mode, charts, and exports</summary>
            <p className="hint">Enter one coordinate pair per line as `UTME,UTMN` to compare candidate points and generate charts.</p>
            <textarea rows={6} value={batchInput} onChange={(e) => setBatchInput(e.target.value)} />
            <div className="buttons compact">
              <button className="btn secondary" onClick={onPredictBatch} disabled={loading || !!batchDraft.error}>
                {loading ? 'Analyzing…' : `Analyze ${batchDraft.points.length || 0} points`}
              </button>
            </div>
            {batchDraft.error ? <div className="error">{batchDraft.error}</div> : null}
          </details>
        </section>

        <section className="card">
          <h2>Site preview</h2>

          <MapPreview
            latitude={mapCenter.latitude}
            longitude={mapCenter.longitude}
            label={markerLabel}
            placeName={placeName || placeDetails}
            onMapClick={handleMapClick}
          />

          <div className="resultPanel">
            {!best ? (
              <div className="muted">No prediction yet. Click the map or use your location to choose a point.</div>
            ) : (
              <>
                <div className="placePanel">
                  <div className="label">Detected place</div>
                  <div className="placeName">{placeName || (lookingUpPlace ? 'Resolving place name…' : 'Place name unavailable')}</div>
                  <div className="muted">{placeDetails || 'Map labels remain visible directly on the basemap.'}</div>
                </div>
                <div className="resultTop">
                  <div className={`badge ${decisionClass}`}>{best.decision}</div>
                  <div className="muted">
                    GPI <b>{best.gpi.toFixed(2)}</b> · Yield <b>{best.predicted_yield_m3h.toFixed(2)} m³/h</b> · SWL{' '}
                    <b>{best.predicted_static_water_level_m.toFixed(2)} m</b>
                  </div>
                  <div className="muted">
                    Coordinates: {best.latitude.toFixed(5)}, {best.longitude.toFixed(5)} · UTME <b>{best.utme.toFixed(0)}</b> · UTMN{' '}
                    <b>{best.utmn.toFixed(0)}</b>
                  </div>
                  <div className="muted">{best.recommendation}</div>
                </div>
                <div className="buttons compact">
                  <button className="btn secondary" onClick={downloadResultsCsv}>
                    Download CSV
                  </button>
                  <button className="btn secondary" onClick={downloadResultsReport}>
                    Download report
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        {results?.length ? (
          <section className="card wide">
            <h2>Visual analysis</h2>
            <Charts results={results} />
          </section>
        ) : null}
      </main>
    </div>
  )
}

export default App
