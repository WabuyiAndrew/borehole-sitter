import { MapContainer, Marker, Popup, TileLayer, Tooltip, useMapEvent } from 'react-leaflet'

type Props = {
  latitude: number
  longitude: number
  label: string
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

export function MapPreview(props: Props) {
  const rawKey = import.meta.env.VITE_MAPTILER_KEY as string | undefined
  const key = rawKey && !rawKey.includes('YOUR_MAPTILER') ? rawKey : undefined
  const tileUrl = key
    ? `https://api.maptiler.com/tiles/satellite/{z}/{x}/{y}.jpg?key=${key}`
    : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
  const attribution = key
    ? '&copy; MapTiler'
    : 'Tiles &copy; Esri, Maxar, Earthstar Geographics, OpenStreetMap contributors'

  return (
    <div style={{ height: 340, width: '100%', borderRadius: 16, overflow: 'hidden', border: '1px solid rgba(15, 118, 110, 0.24)' }}>
      <MapContainer center={[props.latitude, props.longitude]} zoom={12} style={{ height: '100%', width: '100%' }}>
        <TileLayer url={tileUrl} attribution={attribution} />
        <ClickableMap onMapClick={props.onMapClick} />
        <Marker position={[props.latitude, props.longitude]}>
          <Tooltip permanent direction="top" offset={[0, -18]}>
            {props.label}
          </Tooltip>
          <Popup>{props.label}</Popup>
        </Marker>
      </MapContainer>
    </div>
  )
}

