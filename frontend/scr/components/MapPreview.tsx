import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet'

type Props = {
  latitude: number
  longitude: number
  label: string
}

export function MapPreview(props: Props) {
  const key = import.meta.env.VITE_MAPTILER_KEY as string | undefined
  const tileUrl = key
    ? `https://api.maptiler.com/tiles/satellite/{z}/{x}/{y}.jpg?key=${key}`
    : undefined

  return (
    <div style={{ height: 320, width: '100%', borderRadius: 12, overflow: 'hidden', border: '1px solid #2a3a5a' }}>
      <MapContainer center={[props.latitude, props.longitude]} zoom={15} style={{ height: '100%', width: '100%' }}>
        {tileUrl ? (
          <TileLayer url={tileUrl} attribution="&copy; MapTiler" />
        ) : (
          <TileLayer url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
        )}
        <Marker position={[props.latitude, props.longitude]}>
          <Popup>{props.label}</Popup>
        </Marker>
      </MapContainer>
    </div>
  )
}

