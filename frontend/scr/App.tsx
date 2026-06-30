import './App.css'
import { useEffect, useMemo, useState } from 'react'
import {
  convertCoordinates,
  fetchReportPdf,
  getAuthToken as readAuthToken,
  login as apiLogin,
  predict,
  setAuthToken as writeAuthToken,
  signup as apiSignup,
  type ConvertCoordinatesRequest,
  type ConvertCoordinatesResponse,
  type PredictResponse,
  type PredictResult,
  warmBackend,
} from './api'
import { AuthPage, type AuthMode } from './components/AuthPage'
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
const placeLookupCache = new Map<string, PlaceLookup | null>()

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
  const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`
  if (placeLookupCache.has(cacheKey)) {
    return placeLookupCache.get(cacheKey) || null
  }

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
  const placeLookup = buildPlaceLookup(payload, latitude, longitude)
  placeLookupCache.set(cacheKey, placeLookup)
  return placeLookup
}

function escapeCsvValue(value: string | number) {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function formatDistance(distanceMeters: number) {
  if (!Number.isFinite(distanceMeters)) return 'Unavailable'
  if (distanceMeters >= 1000) {
    const rounded = distanceMeters >= 10000 ? 0 : 1
    return `${(distanceMeters / 1000).toFixed(rounded)} km`
  }
  return `${Math.round(distanceMeters)} m`
}

async function saveTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  await saveBlobFile(filename, blob, mimeType)
}

async function saveBlobFile(filename: string, blob: Blob, mimeType: string) {
  const file = new File([blob], filename, { type: mimeType })
  const pickerWindow = window as WindowWithFilePicker
  const extension = filename.includes('.') ? `.${filename.split('.').pop() || 'txt'}` : '.txt'
  const acceptMimeType = mimeType.split(';')[0] || 'text/plain'

  if (typeof pickerWindow.showSaveFilePicker === 'function') {
    try {
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
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      throw err
    }
  }

  const shareData: ShareData = {
    files: [file],
    title: filename,
  }
  const shareNavigator = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean
  }

  if (typeof navigator.share === 'function' && typeof shareNavigator.canShare === 'function' && shareNavigator.canShare(shareData)) {
    try {
      await navigator.share(shareData)
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      throw err
    }
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
  const [token, setToken] = useState<string | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [coordinateMode, setCoordinateMode] = useState<CoordinateMode>('latlon')
  const [utme, setUtme] = useState('')
  const [utmn, setUtmn] = useState('')
  const [latitudeInput, setLatitudeInput] = useState('')
  const [longitudeInput, setLongitudeInput] = useState('')
  const [batchInput, setBatchInput] = useState(DEFAULT_BATCH_INPUT)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<PredictResult[] | null>(null)
  const [predictionWarnings, setPredictionWarnings] = useState<string[]>([])
  const [status, setStatus] = useState<'ready' | 'warming' | 'connected' | 'error'>('warming')
  const [conversion, setConversion] = useState<ConvertCoordinatesResponse | null>(null)
  const [converting, setConverting] = useState(false)
  const [conversionError, setConversionError] = useState<string | null>(null)
  const [locationSummary, setLocationSummary] = useState<string | null>(null)
  const [placeName, setPlaceName] = useState<string | null>(null)
  const [placeDetails, setPlaceDetails] = useState<string | null>(null)
  const [lookingUpPlace, setLookingUpPlace] = useState(false)
  const [manualInteraction, setManualInteraction] = useState(false)

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

    if (/Model not loaded|Model is warming up|503|502|500/i.test(message)) {
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

  async function submitAuth(username: string, password: string) {
    setAuthBusy(true)
    setAuthError(null)
    setAuthMessage(null)
    try {
      if (authMode === 'login') {
        await apiLogin(username, password)
        setToken(readAuthToken())
        setAuthMessage('Signed in for this app session. You will be asked to log in again the next time the app opens.')
        return
      }
      await apiSignup(username, password)
      writeAuthToken(null)
      setToken(null)
      setAuthMode('login')
      setAuthMessage('Account created successfully. Log in to continue.')
    } catch (err) {
      setAuthError(formatRuntimeError(err))
    } finally {
      setAuthBusy(false)
    }
  }

  function logout() {
    writeAuthToken(null)
    setToken(null)
    resetSelectionState('Signed out')
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
  const reliabilityLabel = best
    ? `Nearest calibrated background point: ${formatDistance(best.nearest_background_distance_m)}`
    : 'Reliability indicators appear after prediction.'

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
      return (
        `UTM: Zone ${conversion.authoritative.zone}${authoritativeHemisphere} ` +
        `E ${conversion.authoritative.utme.toFixed(0)} N ${conversion.authoritative.utmn.toFixed(0)} · ` +
        `Model: Zone ${conversion.model.zone}${modelHemisphere} ` +
        `E ${conversion.model.utme.toFixed(0)} N ${conversion.model.utmn.toFixed(0)}`
      )
    }
    return (
      `Lat/Lon: ${conversion.authoritative.latitude.toFixed(5)}, ${conversion.authoritative.longitude.toFixed(5)} · ` +
      `Model: Zone ${conversion.model.zone}${modelHemisphere} E ${conversion.model.utme.toFixed(0)} N ${conversion.model.utmn.toFixed(0)}`
    )
  }, [coordinateMode, conversion])

  useEffect(() => {
    if (!token) return
    let active = true

    void warmBackend().then((ok) => {
      if (!active) return
      setStatus((current) => (current === 'connected' ? current : ok ? 'ready' : 'error'))
    })

    return () => {
      active = false
    }
  }, [token])

  useEffect(() => {
    if (!token || !manualInteraction || !manualDraft.request) {
      setConversion(null)
      setConversionError(null)
      setConverting(false)
      if (coordinateMode === 'latlon') {
        if (!manualInteraction) {
          setUtme('')
          setUtmn('')
        }
      } else {
        if (!manualInteraction) {
          setLatitudeInput('')
          setLongitudeInput('')
        }
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
  }, [coordinateMode, manualDraft.request, manualInteraction, token])

  useEffect(() => {
    if (!token || !manualInteraction || !activePoint) {
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
  }, [activePoint, manualInteraction, token])

  function resetSelectionState(summary: string) {
    setPlaceName(null)
    setPlaceDetails(null)
    setResults(null)
    setPredictionWarnings([])
    setLocationSummary(summary)
    setError(null)
    setConversionError(null)
    setStatus('ready')
  }

  function applyPredictionResponse(resp: PredictResponse, summary: string) {
    setResults(resp.results)
    setPredictionWarnings(resp.warnings || [])
    setUtme(String(Math.round(resp.best.utme)))
    setUtmn(String(Math.round(resp.best.utmn)))
    setLatitudeInput(resp.best.latitude.toFixed(5))
    setLongitudeInput(resp.best.longitude.toFixed(5))
    setLocationSummary(summary)
    setStatus('connected')
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
    setManualInteraction(true)
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

  async function downloadResultsPdf() {
    if (!results?.length || !best || !activePoint) return
    setError(null)
    try {
      const blob = await fetchReportPdf({
        title: 'DrillScout report',
        point_geo: { latitude: activePoint.latitude, longitude: activePoint.longitude },
        best,
        results,
        place_name: placeName,
        place_details: placeDetails,
      })
      await saveBlobFile('drillscout-report.pdf', blob, 'application/pdf')
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

      applyPredictionResponse(
        resp,
        coordinateMode === 'latlon'
          ? 'Backend-converted latitude and longitude were evaluated successfully.'
          : 'Backend-confirmed UTM coordinates were evaluated successfully.',
      )
    } catch (err) {
      setError(formatRuntimeError(err))
      setPredictionWarnings([])
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
      applyPredictionResponse(resp, `Detected your position with ${accuracy}. The map marker moved to your location.`)
    } catch (err) {
      setError(formatRuntimeError(err))
      setPredictionWarnings([])
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
      setConversion(null)
      applyPredictionResponse(resp, `Batch analysis completed for ${resp.results.length} points. The map centers on the best-ranked candidate.`)
    } catch (err) {
      setError(formatRuntimeError(err))
      setPredictionWarnings([])
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  function handleMapClick(latitude: number, longitude: number) {
    setManualInteraction(true)
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

  if (!token) {
    return (
      <AuthPage
        key={authMode}
        mode={authMode}
        busy={authBusy}
        error={authError}
        message={authMessage}
        onSubmit={submitAuth}
        onModeChange={(mode) => {
          setAuthMode(mode)
          setAuthError(null)
          setAuthMessage(null)
        }}
      />
    )
  }

  return (
    <div className="page">
      <header className="hero">
        <div className="heroTop">
          <div>
            <div className="title">DrillScout</div>
            <div className="subtitle">Predict the best borehole siting location from coordinates or your current position.</div>
          </div>
          <div className="heroActions">
            <div className={`status ${status}`}>{statusLabel}</div>
            <button className="btn" type="button" onClick={logout}>
              Sign out
            </button>
          </div>
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
                    setManualInteraction(true)
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
                    setManualInteraction(true)
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
                    setManualInteraction(true)
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
                    setManualInteraction(true)
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
              ? 'Enter latitude and longitude.'
              : 'Enter UTME and UTMN.'}
          </p>
          <p className="hint">Tap the map to pick a point.</p>
          <p className="hint">{locationSummary || conversionHint || (converting ? 'Resolving coordinates…' : 'Choose a point to begin.')}</p>
          <p className="hint">{reliabilityLabel}</p>

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
                  <div className="metricGrid">
                    <div className="metricCard">
                      <div className="metricLabel">GPI</div>
                      <div className="metricValue">{best.gpi.toFixed(2)}</div>
                    </div>
                    <div className="metricCard">
                      <div className="metricLabel">Yield</div>
                      <div className="metricValue">{best.predicted_yield_m3h.toFixed(2)} m³/h</div>
                    </div>
                    <div className="metricCard">
                      <div className="metricLabel">SWL</div>
                      <div className="metricValue">{best.predicted_static_water_level_m.toFixed(2)} m</div>
                    </div>
                    <div className="metricCard">
                      <div className="metricLabel">Nearest reference</div>
                      <div className="metricValue">{formatDistance(best.nearest_background_distance_m)}</div>
                    </div>
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
                  {predictionWarnings.length ? <div className="warningPanel">{predictionWarnings.join(' ')}</div> : null}
                  <div className="muted">{best.recommendation}</div>
                </div>
                <div className="buttons compact">
                  <button className="btn secondary" onClick={() => void downloadResultsCsv()}>
                    Download CSV
                  </button>
                  <button className="btn secondary" onClick={() => void downloadResultsPdf()}>
                    Download PDF
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
