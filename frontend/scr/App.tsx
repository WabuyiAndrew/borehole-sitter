import './App.css'
import { useEffect, useMemo, useState } from 'react'
import {
  convertCoordinates,
  getApiBaseUrl,
  predict,
  type ConvertCoordinatesRequest,
  type ConvertCoordinatesResponse,
  type PredictResult,
  warmBackend,
} from './api'
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

type ManualCoordinateDraft = {
  request: ConvertCoordinatesRequest | null
  error: string | null
  key: string | null
}

type FilePickerWritable = {
  write: (data: Blob) => Promise<void>
  close: () => Promise<void>
}

type FilePickerHandle = {
  createWritable: () => Promise<FilePickerWritable>
}

type WindowWithFilePicker = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types?: Array<{
      description: string
      accept: Record<string, string[]>
    }>
  }) => Promise<FilePickerHandle>
}

const DEFAULT_LOCATION: LatLng = {
  latitude: 0.44747,
  longitude: 32.33873,
}

const DEFAULT_BATCH_INPUT = ['520000,180000', '520250,180250', '520500,180500'].join('\n')

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

function isValidUtme(value: number) {
  return value >= 100000 && value <= 900000
}

function isValidUtmn(value: number) {
  return value >= 0 && value <= 10000000
}

function deriveManualCoordinateRequest(
  coordinateMode: CoordinateMode,
  utme: string,
  utmn: string,
  latitudeInput: string,
  longitudeInput: string,
): ManualCoordinateDraft {
  if (coordinateMode === 'latlon') {
    if (!hasValue(latitudeInput) || !hasValue(longitudeInput)) {
      return { request: null, error: 'Enter both latitude and longitude.', key: null }
    }

    const latitude = Number(latitudeInput)
    const longitude = Number(longitudeInput)

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return { request: null, error: 'Please enter valid numeric latitude and longitude values.', key: null }
    }

    if (!isValidLatitude(latitude)) {
      return { request: null, error: 'Latitude must be between -90 and 90.', key: null }
    }

    if (!isValidLongitude(longitude)) {
      return { request: null, error: 'Longitude must be between -180 and 180.', key: null }
    }

    return {
      request: {
        point_geo: {
          latitude,
          longitude,
        },
      },
      error: null,
      key: `geo:${latitude}:${longitude}`,
    }
  }

  if (!hasValue(utme) || !hasValue(utmn)) {
    return { request: null, error: 'Enter both UTME and UTMN.', key: null }
  }

  const parsedUtme = Number(utme)
  const parsedUtmn = Number(utmn)

  if (!Number.isFinite(parsedUtme) || !Number.isFinite(parsedUtmn)) {
    return { request: null, error: 'Please enter valid numeric UTME and UTMN values.', key: null }
  }

  if (!isValidUtme(parsedUtme)) {
    return { request: null, error: 'UTME must be between 100000 and 900000 meters.', key: null }
  }

  if (!isValidUtmn(parsedUtmn)) {
    return { request: null, error: 'UTMN must be between 0 and 10000000 meters.', key: null }
  }

  return {
    request: {
      point_utm: {
        utme: parsedUtme,
        utmn: parsedUtmn,
      },
    },
    error: null,
    key: `utm:${parsedUtme}:${parsedUtmn}`,
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

async function saveTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const file = new File([blob], filename, { type: mimeType })
  const pickerWindow = window as WindowWithFilePicker
  const extension = filename.includes('.') ? `.${filename.split('.').pop() || 'txt'}` : '.txt'
  const acceptMimeType = mimeType.split(';')[0] || 'text/plain'

  if (typeof pickerWindow.showSaveFilePicker === 'function') {
    const handle = await pickerWindow.showSaveFilePicker({
      suggestedName: filename,
      types: [
        {
          description: 'Exported file',
          accept: {
            [acceptMimeType]: [extension],
          },
        },
      ],
    })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return
  }

  const shareData: ShareData = {
    files: [file],
    title: filename,
  }
  const shareNavigator = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean
  }

  if (typeof navigator.share === 'function' && typeof shareNavigator.canShare === 'function' && shareNavigator.canShare(shareData)) {
    await navigator.share(shareData)
    return
  }

  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.rel = 'noopener'
  link.target = '_blank'
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
  const [conversion, setConversion] = useState<ConvertCoordinatesResponse | null>(null)
  const [converting, setConverting] = useState(false)
  const [conversionError, setConversionError] = useState<string | null>(null)
  const [locationSummary, setLocationSummary] = useState<string | null>(null)
  const [placeName, setPlaceName] = useState<string | null>(null)
  const [placeDetails, setPlaceDetails] = useState<string | null>(null)
  const [lookingUpPlace, setLookingUpPlace] = useState(false)

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

  const best = useMemo(() => (results && results.length ? results[0] : null), [results])
  const latLonDraft = useMemo(
    () => deriveManualCoordinateRequest('latlon', '', '', latitudeInput, longitudeInput),
    [latitudeInput, longitudeInput],
  )
  const utmDraft = useMemo(() => deriveManualCoordinateRequest('utm', utme, utmn, '', ''), [utme, utmn])
  const manualDraft = coordinateMode === 'latlon' ? latLonDraft : utmDraft
  const rawLatLonPoint = useMemo(() => {
    const latitude = Number(latitudeInput)
    const longitude = Number(longitudeInput)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null
    return { latitude, longitude }
  }, [latitudeInput, longitudeInput])
  const canPredict = !loading && !converting && !!manualDraft.request && !manualDraft.error

  const decisionClass =
    best?.decision === 'Suitable' ? 'good' : best?.decision === 'Moderate' ? 'warn' : best ? 'bad' : 'muted'

  const activePoint = useMemo(() => {
    if (best) {
      return {
        latitude: best.latitude,
        longitude: best.longitude,
      }
    }
    if (conversion) {
      return {
        latitude: conversion.authoritative.latitude,
        longitude: conversion.authoritative.longitude,
      }
    }
    return rawLatLonPoint
  }, [best, conversion, rawLatLonPoint])
  const mapCenter = useMemo(() => activePoint || DEFAULT_LOCATION, [activePoint])
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
    if (!conversion) return null
    const authoritativeHemisphere = conversion.authoritative.northern ? 'N' : 'S'
    const modelHemisphere = conversion.model.northern ? 'N' : 'S'
    if (coordinateMode === 'latlon') {
      const authoritativeText =
        `Backend authoritative conversion: Zone ${conversion.authoritative.zone}${authoritativeHemisphere} ` +
        `UTME ${conversion.authoritative.utme.toFixed(2)} and UTMN ${conversion.authoritative.utmn.toFixed(2)}.`
      const modelText =
        `Model input: Zone ${conversion.model.zone}${modelHemisphere} ` +
        `UTME ${conversion.model.utme.toFixed(2)} and UTMN ${conversion.model.utmn.toFixed(2)}.`
      return `${authoritativeText} ${modelText}`
    }
    return (
      `Backend-confirmed location: ${conversion.authoritative.latitude.toFixed(5)}, ${conversion.authoritative.longitude.toFixed(5)}. ` +
      `Model input remains Zone ${conversion.model.zone}${modelHemisphere}.`
    )
  }, [coordinateMode, conversion])

  useEffect(() => {
    let active = true

    void warmBackend().then((ok) => {
      if (!active) return
      setStatus((current) => (current === 'connected' ? current : ok ? 'ready' : 'error'))
    })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!manualDraft.request) {
      setConversion(null)
      setConversionError(null)
      setConverting(false)
      if (coordinateMode === 'latlon') {
        setUtme('')
        setUtmn('')
      } else {
        setLatitudeInput('')
        setLongitudeInput('')
      }
      return
    }

    const request = manualDraft.request
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => {
      setConverting(true)
      void convertCoordinates(request, controller.signal)
        .then((response) => {
          setConversion(response)
          setConversionError(null)
          if (coordinateMode === 'latlon') {
            setUtme(String(Math.round(response.model.utme)))
            setUtmn(String(Math.round(response.model.utmn)))
          } else {
            setLatitudeInput(response.authoritative.latitude.toFixed(5))
            setLongitudeInput(response.authoritative.longitude.toFixed(5))
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          setConversion(null)
          setConversionError(formatRuntimeError(err))
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setConverting(false)
          }
        })
    }, 250)

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [coordinateMode, manualDraft.request])

  useEffect(() => {
    if (!activePoint) {
      setPlaceName(null)
      setPlaceDetails(null)
      setLookingUpPlace(false)
      return
    }

    const controller = new AbortController()
    setLookingUpPlace(true)

    void reverseGeocodePoint(activePoint.latitude, activePoint.longitude, controller.signal)
      .then((place) => {
        if (!place) {
          setPlaceName(null)
          setPlaceDetails(null)
          return
        }
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
  }, [activePoint])

  function resetSelectionState(summary: string) {
    setPlaceName(null)
    setPlaceDetails(null)
    setResults(null)
    setLocationSummary(summary)
    setError(null)
    setConversionError(null)
    setStatus('ready')
  }

  function syncInputsFromConversion(nextConversion: ConvertCoordinatesResponse) {
    setConversion(nextConversion)
    setConversionError(null)
    setUtme(String(Math.round(nextConversion.model.utme)))
    setUtmn(String(Math.round(nextConversion.model.utmn)))
    setLatitudeInput(nextConversion.authoritative.latitude.toFixed(5))
    setLongitudeInput(nextConversion.authoritative.longitude.toFixed(5))
  }

  function switchCoordinateMode(nextMode: CoordinateMode) {
    if (conversion) {
      syncInputsFromConversion(conversion)
    }
    setCoordinateMode(nextMode)
    resetSelectionState(nextMode === 'latlon' ? 'Latitude and longitude input selected.' : 'UTM coordinate input selected.')
  }

  async function downloadResultsCsv() {
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

    try {
      await saveTextFile('drillscout-findings.csv', [header.join(','), ...rows].join('\n'), 'text/csv;charset=utf-8')
    } catch (err) {
      setError(formatRuntimeError(err))
    }
  }

  async function downloadResultsReport() {
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
      `Model coordinates: UTME ${best.utme.toFixed(2)}, UTMN ${best.utmn.toFixed(2)}`,
      `Latitude/Longitude: ${best.latitude.toFixed(5)}, ${best.longitude.toFixed(5)}`,
      conversion
        ? `Authoritative UTM: Zone ${conversion.authoritative.zone}${conversion.authoritative.northern ? 'N' : 'S'} · UTME ${conversion.authoritative.utme.toFixed(2)} · UTMN ${conversion.authoritative.utmn.toFixed(2)}`
        : 'Authoritative UTM: Not available',
      `Recommendation: ${best.recommendation}`,
      '',
      'All evaluated points',
      ...results.map(
        (result, index) =>
          `${index + 1}. ${result.decision} | GPI ${result.gpi.toFixed(2)} | Yield ${result.predicted_yield_m3h.toFixed(2)} m³/h | SWL ${result.predicted_static_water_level_m.toFixed(2)} m | UTME ${result.utme.toFixed(2)} | UTMN ${result.utmn.toFixed(2)}`,
      ),
    ]

    try {
      await saveTextFile('drillscout-findings-report.txt', lines.join('\n'), 'text/plain;charset=utf-8')
    } catch (err) {
      setError(formatRuntimeError(err))
    }
  }

  async function onPredictManual() {
    setError(null)
    setLoading(true)
    setStatus('warming')
    try {
      if (!manualDraft.request) {
        throw new Error(manualDraft.error || 'Enter a valid location before predicting.')
      }

      let resp
      if ('point_geo' in manualDraft.request) {
        resp = await predict({
          source: 'manual',
          point_geo: manualDraft.request.point_geo,
        })
      } else {
        resp = await predict({
          source: 'manual',
          point_utm: {
            utme: manualDraft.request.point_utm.utme,
            utmn: manualDraft.request.point_utm.utmn,
          },
        })
      }

      setResults(resp.results)
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setLatitudeInput(resp.best.latitude.toFixed(5))
      setLongitudeInput(resp.best.longitude.toFixed(5))
      setLocationSummary(
        coordinateMode === 'latlon'
          ? 'Backend-converted latitude and longitude were evaluated successfully.'
          : 'Backend-confirmed UTM coordinates were evaluated successfully.',
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
      const converted = await convertCoordinates({ point_geo: { longitude, latitude } })

      setCoordinateMode('latlon')
      syncInputsFromConversion(converted)

      const accuracy =
        typeof pos.coords.accuracy === 'number' && Number.isFinite(pos.coords.accuracy)
          ? `accuracy about ${Math.round(pos.coords.accuracy)} m`
          : 'device GPS reading available'
      setLocationSummary(`Detected your current position with ${accuracy}.`)

      const resp = await predict({ source: 'geolocation', point_geo: { longitude, latitude } })
      setResults(resp.results)
      setUtme(String(Math.round(resp.best.utme)))
      setUtmn(String(Math.round(resp.best.utmn)))
      setLatitudeInput(resp.best.latitude.toFixed(5))
      setLongitudeInput(resp.best.longitude.toFixed(5))
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
      setConversion(null)
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
    setCoordinateMode('latlon')
    setLatitudeInput(latitude.toFixed(5))
    setLongitudeInput(longitude.toFixed(5))
    setUtme('')
    setUtmn('')
    setConversion(null)
    setPlaceName(null)
    setPlaceDetails(null)
    setResults(null)
    setLocationSummary('Map selection updated. Run prediction to evaluate this point.')
    setError(null)
    setConversionError(null)
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
              {loading ? 'Predicting…' : converting ? 'Converting…' : 'Predict suitability'}
            </button>
          </div>

          {error ? <div className="error">{error}</div> : null}
          {!error && manualDraft.error ? <div className="error">{manualDraft.error}</div> : null}
          {!error && !manualDraft.error && conversionError ? <div className="error">{conversionError}</div> : null}
          <p className="hint">
            {coordinateMode === 'latlon'
              ? 'Enter latitude and longitude in decimal degrees. The backend returns authoritative converted coordinates and the model-aligned UTM input.'
              : 'Enter UTME and UTMN in meters for the model coordinate system (Zone 36N), or switch to latitude/longitude for general place entry.'}
          </p>
          <p className="hint">Click the map to choose a point and automatically fill both coordinate formats.</p>
          <p className="hint">{locationSummary || conversionHint || (converting ? 'Resolving coordinates with the backend…' : 'Choose a point to begin.')}</p>

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
              <div className="muted">No prediction yet. Click the map, enter coordinates, or use your location to choose a point.</div>
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
                    Coordinates: {best.latitude.toFixed(5)}, {best.longitude.toFixed(5)} · Model UTME <b>{best.utme.toFixed(0)}</b> · Model UTMN{' '}
                    <b>{best.utmn.toFixed(0)}</b>
                  </div>
                  {conversion ? (
                    <div className="muted">
                      Authoritative UTM: Zone {conversion.authoritative.zone}
                      {conversion.authoritative.northern ? 'N' : 'S'} · UTME <b>{conversion.authoritative.utme.toFixed(0)}</b> · UTMN{' '}
                      <b>{conversion.authoritative.utmn.toFixed(0)}</b>
                    </div>
                  ) : null}
                  <div className="muted">{best.recommendation}</div>
                </div>
                <div className="buttons compact">
                  <button className="btn secondary" onClick={() => void downloadResultsCsv()}>
                    Download CSV
                  </button>
                  <button className="btn secondary" onClick={() => void downloadResultsReport()}>
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
