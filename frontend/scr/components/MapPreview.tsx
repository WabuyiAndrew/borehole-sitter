import { MapContainer, Marker, Popup, TileLayer, Tooltip } from 'react-leaflet'

type Props = {
  latitude: number
  longitude: number
  label: string
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
    <div style={{ height: 320, width: '100%', borderRadius: 12, overflow: 'hidden', border: '1px solid #2a3a5a' }}>
      <MapContainer center={[props.latitude, props.longitude]} zoom={15} style={{ height: '100%', width: '100%' }}>
        <TileLayer url={tileUrl} attribution={attribution} />
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

