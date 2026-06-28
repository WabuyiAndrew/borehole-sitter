import { useEffect } from 'react'
import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMap, useMapEvent } from 'react-leaflet'

type Props = {
  latitude: number
  longitude: number
  label: string
  placeName?: string | null
  onMapClick?: (latitude: number, longitude: number) => void
}

function ClickableMap({ onMapClick }: { onMapClick?: (latitude: number, longitude: number) => void }) {
  useMapEvent('click', (event) => {
    if (onMapClick) {
      onMapClick(event.latlng.lat, event.latlng.lng)
    }
  })
  return null
}

function RecenterMap({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap()

  useEffect(() => {
    map.setView([latitude, longitude], Math.max(map.getZoom(), 13), { animate: true })
  }, [latitude, longitude, map])

  return null
}

export function MapPreview(props: Props) {
  const rawKey = import.meta.env.VITE_MAPTILER_KEY as string | undefined
  const key = rawKey && !rawKey.includes('YOUR_MAPTILER') ? rawKey : undefined
  const tileUrl = key
    ? `https://api.maptiler.com/tiles/satellite/{z}/{x}/{y}.jpg?key=${key}`
    : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  const labelTileUrl = key
    ? `https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.png?key=${key}`
    : 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png'
  const attribution = key
    ? '&copy; MapTiler'
    : 'Tiles &copy; Esri, Maxar, Earthstar Geographics, OpenStreetMap contributors'
  const labelAttribution = key ? '&copy; MapTiler' : '&copy; OpenStreetMap contributors &copy; CARTO'

  return (
    <div style={{ height: 340, width: '100%', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(15, 118, 110, 0.24)' }}>
      <MapContainer center={[props.latitude, props.longitude]} zoom={12} style={{ height: '100%', width: '100%' }}>
        <TileLayer url={tileUrl} attribution={attribution} />
        <TileLayer url={labelTileUrl} attribution={labelAttribution} opacity={0.95} />
        <RecenterMap latitude={props.latitude} longitude={props.longitude} />
        <ClickableMap onMapClick={props.onMapClick} />
        <Marker position={[props.latitude, props.longitude]}>
          <Tooltip permanent direction="top" offset={[0, -18]}>
            {props.label}
          </Tooltip>
          <Popup>
            <div style={{ display: 'grid', gap: 4 }}>
              <strong>{props.placeName || 'Selected place'}</strong>
              <span>{props.label}</span>
              <span>
                {props.latitude.toFixed(5)}, {props.longitude.toFixed(5)}
              </span>
            </div>
          </Popup>
        </Marker>
      </MapContainer>
    </div>
  )
}
