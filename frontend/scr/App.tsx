import './App.css'
import { useEffect, useMemo, useState } from 'react'
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

type CoordinateMode = 'latlon' | 'utm'

type PlaceLookup = {
  title: string
  fullLabel: string
}

type ManualPointDraft = {
  source: CoordinateMode
  utme: number
  utmn: number
  latitude: number
  longitude: number
}

const DEFAULT_LOCATION: LatLng = {
  latitude: 0.44747,
  longitude: 32.33873,
}

const DEFAULT_BATCH_INPUT = ['520000,180000', '520250,180250', '520500,180500'].join('\n')

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

function hasValue(value: string) {
  return value.trim().length > 0
}

function isValidLatitude(value: number) {
  return value >= -90 && value <= 90
}

function isValidLongitude(value: number) {
  return value >= -180 && value <= 180
}

function deriveManualPoint(
  coordinateMode: CoordinateMode,
  utme: string,
  utmn: string,
  latitudeInput: string,
  longitudeInput: string,
): { point: ManualPointDraft | null; error: string | null } {
  if (coordinateMode === 'latlon') {
    if (!hasValue(latitudeInput) || !hasValue(longitudeInput)) {
      return { point: null, error: 'Enter both latitude and longitude.' }
    }

    const latitude = Number(latitudeInput)
    const longitude = Number(longitudeInput)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { point: null, error: 'Please enter valid numeric latitude and longitude values.' }
    }

    if (!isValidLatitude(latitude)) {
      return { point: null, error: 'Latitude must be between -90 and 90.' }
    }

    if (!isValidLongitude(longitude)) {
      return { point: null, error: 'Longitude must be between -180 and 180.' }
    }

    const pointUtm = latLonToUtm(latitude, longitude)
    return {
      point: {
        source: 'latlon',
        latitude,
        longitude,
        utme: pointUtm.utme,
        utmn: pointUtm.utmn,
      },
      error: null,
    }
  }

  if (!hasValue(utme) || !hasValue(utmn)) {
    return { point: null, error: 'Enter both UTME and UTMN.' }
  }

  const parsedUtme = Number(utme)
  const parsedUtmn = Number(utmn)

  if (!Number.isFinite(parsedUtme) || !Number.isFinite(parsedUtmn)) {
    return { point: null, error: 'Please enter valid numeric UTME and UTMN values.' }
  }

  const pointGeo = utmToLatLon(parsedUtme, parsedUtmn)
  return {
    point: {
      source: 'utm',
      utme: parsedUtme,
      utmn: parsedUtmn,
      latitude: pointGeo.latitude,
      longitude: pointGeo.longitude,
    },
    error: null,
  }
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
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(href), 1000)
}

function App() {
  const [coordinateMode, setCoordinateMode] = useState<CoordinateMode>('latlon')
  const [utme, setUtme] = useState('')
  const [utmn, setUtmn] = useState('')
  const [latitudeInput, setLatitudeInput] = useState(String(DEFAULT_LOCATION.latitude))
  const [longitudeInput, setLongitudeInput] = useState(String(DEFAULT_LOCATION.longitude))
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
  const manualDraft = useMemo(
    () => deriveManualPoint(coordinateMode, utme, utmn, latitudeInput, longitudeInput),
    [coordinateMode, utme, utmn, latitudeInput, longitudeInput],
  )
  const canPredict = !loading && !!manualDraft.point && !manualDraft.error

  const decisionClass =
    best?.decision === 'Suitable' ? 'good' : best?.decision === 'Moderate' ? 'warn' : best ? 'bad' : 'muted'

  const mapCenter = useMemo(() => {
    if (selectedPoint) return selectedPoint
    if (manualDraft.point) {
      return {
        latitude: manualDraft.point.latitude,
        longitude: manualDraft.point.longitude,
      }
    }
    return DEFAULT_LOCATION
  }, [selectedPoint, manualDraft])
  const batchDraft = useMemo(() => {
    try {
      const points = parseBatchInput(batchInput)
      return { points, error: null as string | null }
    } catch (err) {
      return { points: [] as BatchPoint[], error: err instanceof Error ? err.message : String(err) }
    }
  }, [batchInput])

  const statusLabel =
    status === 'warming' ? 'Checking service' : status === 'ready' ? 'Ready' : status === 'connected' ? 'Connected' : 'Needs attention'
  const markerLabel = best
    ? `${placeName ? `${placeName} · ` : ''}${best.decision} · Yield ${best.predicted_yield_m3h.toFixed(2)} m³/h · GPI ${best.gpi.toFixed(1)}`
    : `${placeName ? `${placeName} · ` : ''}Current selection`
  const conversionHint = useMemo(() => {
    if (!manualDraft.point) return null
    if (coordinateMode === 'latlon') {
      return `Converted automatically to UTME ${manualDraft.point.utme.toFixed(0)} and UTMN ${manualDraft.point.utmn.toFixed(0)}.`
    }
    return `Equivalent to latitude ${manualDraft.point.latitude.toFixed(5)} and longitude ${manualDraft.point.longitude.toFixed(5)}.`
  }, [coordinateMode, manualDraft])

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
    if (!selectedPoint) {
      setPlaceName(null)
      setPlaceDetails(null)
      setLookingUpPlace(false)
      return
    }

    const controller = new AbortController()
    setLookingUpPlace(true)

    void reverseGeocodePoint(selectedPoint.latitude, selectedPoint.longitude, controller.signal)
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
  }, [selectedPoint])

  function formatRuntimeError(err: unknown) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'No internet connection detected. Check your network and try again.'
    }

    if (typeof err === 'object' && err !== null && 'code' in err) {
      const maybe = err as Record<string, unknown>
      const code = Number(maybe.code)
      if (code === 1) return 'Location permission was denied. Allow location access and try again.'
      if (code === 2) return 'Your location could not be determined right now. Move to an open area and try again.'
      if (code === 3) return 'Location detection took too long. Please try again.'
    }

    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as Record<string, unknown>).message)
            : String(err)

    if (
      /latitude|longitude|UTME|UTMN|at least two coordinate pairs|Enter a valid location|numeric/i.test(message)
    ) {
      return message
    }

    if (/taking longer than expected|timed out|timeout/i.test(message)) {
      return 'The service is taking longer than expected. Please try again in a moment.'
    }

    if (/unable to reach|could not reach|Failed to fetch|Load failed|NetworkError/i.test(message)) {
      return 'We could not connect right now. Check your internet connection and try again.'
    }

    if (/Geolocation is unavailable/i.test(message)) {
      return 'Location services are not available on this device.'
    }

    if (/Model not loaded|503|502|500/i.test(message)) {
      return 'The service is temporarily unavailable. Please try again shortly.'
    }

    if (message && message !== 'undefined') return message

    if (typeof err === 'object' && err !== null) {
      const maybe = err as Record<string, unknown>
      if (typeof maybe.message === 'string') return maybe.message
      if ('code' in maybe) return `Error ${String(maybe.code)}: ${String(maybe.message ?? 'Location not available')}`
    }
    return 'Something went wrong while processing your request. Please try again.'
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

  function switchCoordinateMode(nextMode: CoordinateMode) {
    if (manualDraft.point) {
      setUtme(String(Math.round(manualDraft.point.utme)))
      setUtmn(String(Math.round(manualDraft.point.utmn)))
      setLatitudeInput(manualDraft.point.latitude.toFixed(5))
      setLongitudeInput(manualDraft.point.longitude.toFixed(5))
    }
    setCoordinateMode(nextMode)
    resetSelectionState(nextMode === 'latlon' ? 'Latitude and longitude input selected.' : 'UTM coordinate input selected.')
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
      if (!manualDraft.point) {
        throw new Error(manualDraft.error || 'Enter a valid location before predicting.')
      }
      const resp =
        coordinateMode === 'latlon'
          ? await predict({
              source: 'manual',
              point_geo: {
                latitude: manualDraft.point.latitude,
                longitude: manualDraft.point.longitude,
              },
            })
          : await predict({
              source: 'manual',
              point_utm: {
                utme: manualDraft.point.utme,
                utmn: manualDraft.point.utmn,
              },
            })
      setResults(resp.results)
      setSelectedPoint({ latitude: resp.best.latitude, longitude: resp.best.longitude })
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setLatitudeInput(resp.best.latitude.toFixed(5))
      setLongitudeInput(resp.best.longitude.toFixed(5))
      setLocationSummary(
        coordinateMode === 'latlon'
          ? 'Latitude and longitude were converted automatically and evaluated successfully.'
          : 'UTM coordinates were evaluated successfully.',
      )
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
        throw new Error('Geolocation is unavailable in this browser or app environment.')
      }
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 60000,
        })
      })
      const longitude = pos.coords.longitude
      const latitude = pos.coords.latitude
      const detectedUtm = latLonToUtm(latitude, longitude)

      setCoordinateMode('latlon')
      setSelectedPoint({ latitude, longitude })
      setUtme(String(Math.round(detectedUtm.utme)))
      setUtmn(String(Math.round(detectedUtm.utmn)))
      setLatitudeInput(latitude.toFixed(5))
      setLongitudeInput(longitude.toFixed(5))

      const accuracy =
        typeof pos.coords.accuracy === 'number' && Number.isFinite(pos.coords.accuracy)
          ? `accuracy about ${Math.round(pos.coords.accuracy)} m`
          : 'device GPS reading available'
      setLocationSummary(`Detected your current position with ${accuracy}.`)

      const resp = await predict({ source: 'geolocation', point_geo: { longitude, latitude } })
      setResults(resp.results)
      setSelectedPoint({ latitude: resp.best.latitude, longitude: resp.best.longitude })
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
      setLatitudeInput(resp.best.latitude.toFixed(5))
      setLongitudeInput(resp.best.longitude.toFixed(5))
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
    const utm = latLonToUtm(latitude, longitude)
    setCoordinateMode('latlon')
    setUtme(String(Math.round(utm.utme)))
    setUtmn(String(Math.round(utm.utmn)))
    setLatitudeInput(latitude.toFixed(5))
    setLongitudeInput(longitude.toFixed(5))
    setSelectedPoint({ latitude, longitude })
    setPlaceName(null)
    setPlaceDetails(null)
    setResults(null)
    setLocationSummary('Map selection updated. Run prediction to evaluate this point.')
    setError(null)
    setStatus('ready')
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

          <div className="modeToggle">
            <button
              className={`toggleBtn ${coordinateMode === 'latlon' ? 'active' : ''}`}
              onClick={() => switchCoordinateMode('latlon')}
              type="button"
            >
              Latitude / Longitude
            </button>
            <button
              className={`toggleBtn ${coordinateMode === 'utm' ? 'active' : ''}`}
              onClick={() => switchCoordinateMode('utm')}
              type="button"
            >
              UTME / UTMN
            </button>
          </div>

          {coordinateMode === 'latlon' ? (
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
                  placeholder="204456"
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
                  placeholder="49484"
                />
              </label>
            </div>
          )}

          <div className="buttons">
            <button className="btn" onClick={onUseMyLocation} disabled={loading}>
              Use my location
            </button>
            <button className="btn primary" onClick={onPredictManual} disabled={!canPredict}>
              {loading ? 'Predicting…' : 'Predict suitability'}
            </button>
          </div>

          {error ? <div className="error">{error}</div> : null}
          {!error && manualDraft.error ? <div className="error">{manualDraft.error}</div> : null}
          <p className="hint">
            {coordinateMode === 'latlon'
              ? 'Enter latitude and longitude in decimal degrees, then the app converts them automatically for the model.'
              : 'Enter UTME and UTMN in meters, or switch to latitude/longitude if that is easier for the user.'}
          </p>
          <p className="hint">Click the map to choose a point and automatically fill both coordinate formats.</p>
          <p className="hint">{locationSummary || conversionHint || 'Choose a point to begin.'}</p>

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
