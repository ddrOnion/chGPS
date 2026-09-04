import { useState, useEffect, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import './App.css'

const redIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
})

const defaultIcon = new L.Icon.Default()

const STORAGE_KEY = 'chgps.locations'

// One counter per session hands out every id, including ids for points read back
// from storage. Date.now() used to collide when two clicks landed in the same
// millisecond, which duplicated React keys.
let idCounter = 0
const nextId = () => ++idCounter

/**
 * Saved points survive a reload. Anything malformed is dropped rather than
 * allowed to crash the list — the key is user-writable and may predate a
 * schema change.
 */
function loadLocations() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((c) => (
        Number.isFinite(c?.lat) && Number.isFinite(c?.lng) &&
        Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180
      ))
      .map((c) => ({
        id: nextId(),
        lat: c.lat,
        lng: c.lng,
        name: typeof c.name === 'string' ? c.name : ''
      }))
  } catch {
    return []
  }
}

/** Falls back to the positional label while a point has no tag of its own. */
const labelOf = (coord, index) => coord.name.trim() || `Location ${index + 1}`

/** Normalizes longitude to [-180, 180] degrees. */
function wrapLongitude(lng) {
  if (!Number.isFinite(lng)) return 0
  if (lng >= -180 && lng <= 180) return lng
  let wrapped = (lng + 180) % 360
  if (wrapped < 0) wrapped += 360
  return wrapped - 180
}

const CRUISE_DIRECTIONS = {
  W: { id: 'W', label: '西', fullLabel: '向西', arrow: '⬅️', keyName: 'ArrowLeft' },
  E: { id: 'E', label: '東', fullLabel: '向東', arrow: '➡️', keyName: 'ArrowRight' },
  N: { id: 'N', label: '北', fullLabel: '向北', arrow: '⬆️', keyName: 'ArrowUp' },
  S: { id: 'S', label: '南', fullLabel: '向南', arrow: '⬇️', keyName: 'ArrowDown' }
}

const CRUISE_SPEEDS = [19, 18.5, 18]

/**
 * 依指定時速 (km/h)、更新週期 (秒)、航向 (N/S/E/W) 與垂直擾動設定，計算單步經緯度位移。
 * 地球平均半徑 R ≈ 6,371,000 公尺。
 */
function calculateCruiseStep(
  lat,
  lng,
  speedKmPerHour = 19,
  intervalSeconds = 2,
  direction = 'W',
  applyPerturbation = false,
  perturbationSign = 1,
  perturbationMeters = 5
) {
  const R = 6371000 // 地球平均半徑 (公尺)
  const speedMps = (speedKmPerHour * 1000) / 3600
  const mainDistanceM = speedMps * intervalSeconds

  const latRad = (lat * Math.PI) / 180
  const cosLat = Math.max(Math.abs(Math.cos(latRad)), 1e-6)

  // 1. 主航向位移
  let deltaLatMain = 0
  let deltaLngMain = 0

  if (direction === 'W') {
    deltaLngMain = -((mainDistanceM / (R * cosLat)) * (180 / Math.PI))
  } else if (direction === 'E') {
    deltaLngMain = +((mainDistanceM / (R * cosLat)) * (180 / Math.PI))
  } else if (direction === 'N') {
    deltaLatMain = +((mainDistanceM / R) * (180 / Math.PI))
  } else if (direction === 'S') {
    deltaLatMain = -((mainDistanceM / R) * (180 / Math.PI))
  }

  // 2. 每 6 秒觸發的垂直分量擾動 (5 公尺)
  let deltaLatPerp = 0
  let deltaLngPerp = 0

  if (applyPerturbation && perturbationMeters > 0) {
    const perpDist = perturbationSign * perturbationMeters
    if (direction === 'W' || direction === 'E') {
      // 主航向為東西，垂直擾動作用於南北 (緯度)
      deltaLatPerp = (perpDist / R) * (180 / Math.PI)
    } else {
      // 主航向為南北，垂直擾動作用於東西 (經度)
      deltaLngPerp = (perpDist / (R * cosLat)) * (180 / Math.PI)
    }
  }

  const nextLat = Math.max(-90, Math.min(90, lat + deltaLatMain + deltaLatPerp))
  const nextLng = wrapLongitude(lng + deltaLngMain + deltaLngPerp)

  return {
    lat: nextLat,
    lng: nextLng,
    mainDistanceM,
    perturbed: applyPerturbation
  }
}

function MapClick({ onCoordinateSelect }) {
  useMapEvents({
    click: (e) => {
      const wrapped = e.latlng.wrap()
      onCoordinateSelect({ lat: wrapped.lat, lng: wrapped.lng })
    }
  })
  return null
}

/** MapContainer's `center` prop only applies on mount, so recentering needs the map instance. */
function Recenter({ center }) {
  const map = useMap()
  useEffect(() => {
    if (center && Array.isArray(center) && center.length === 2) {
      const lat = Number(center[0])
      const lng = Number(center[1])
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        map.setView([lat, lng], map.getZoom())
      }
    }
  }, [center, map])
  return null
}

function useDeviceStatus(pollMs = 8000) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/status${fresh ? '?fresh=1' : ''}`)
      setStatus(await res.json())
    } catch {
      setStatus({ bridgeDown: true })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(() => refresh(), pollMs)
    return () => clearInterval(id)
  }, [refresh, pollMs])

  return { status, loading, refresh }
}

function DevicePanel({ status, loading, onRefresh, onMountDdi, busy }) {
  if (loading) return <div className="device-panel"><span className="dot dot-idle" /> 連線中…</div>

  if (!status || status.bridgeDown) {
    return (
      <div className="device-panel device-error">
        <span className="dot dot-bad" />
        <div>
          <strong>Bridge 未啟動</strong>
          <p>請執行 <code>npm run server</code></p>
        </div>
      </div>
    )
  }

  if (!status.connected) {
    return (
      <div className="device-panel device-error">
        <span className="dot dot-bad" />
        <div>
          <strong>未偵測到 iPhone</strong>
          <p>請以 USB 連接並解鎖螢幕</p>
        </div>
        <button className="btn-small" onClick={() => onRefresh(true)}>↻</button>
      </div>
    )
  }

  const { device, ready, blockers } = status

  return (
    <div className={`device-panel ${ready ? 'device-ready' : 'device-warn'}`}>
      <span className={`dot ${ready ? 'dot-good' : 'dot-warn'}`} />
      <div className="device-info">
        <strong>{device.name}</strong>
        <p>{device.model} · iOS {device.iosVersion}</p>
        {!ready && (
          <ul className="blocker-list">
            {blockers.map((b) => (
              <li key={b.code}>
                {b.message}
                {b.code === 'DDI_NOT_MOUNTED' && (
                  <button className="btn-inline" onClick={onMountDdi} disabled={busy}>
                    {busy ? '掛載中…' : '立即掛載'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {ready && <p className="ready-text">✓ 可傳送定位</p>}
      </div>
      <button className="btn-small" onClick={() => onRefresh(true)} title="重新檢查">↻</button>
    </div>
  )
}

function App() {
  const [coordinates, setCoordinates] = useState(loadLocations)
  // Selection is held by id, not position. Deleting a point above the selected
  // one shifts every later index, which used to silently re-target the editor at
  // a different point and could leave the index past the end of the list.
  const [activeId, setActiveId] = useState(null)
  const [inputLat, setInputLat] = useState('')
  const [inputLng, setInputLng] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [mapCenter, setMapCenter] = useState([25.0330, 121.5654])
  const [sending, setSending] = useState(false)
  const [mounting, setMounting] = useState(false)
  const [toast, setToast] = useState(null)
  const [appliedCoord, setAppliedCoord] = useState(null)
  const [isCruising, setIsCruising] = useState(false)
  const [cruisingCoordId, setCruisingCoordId] = useState(null)
  const [cruiseSpeed, setCruiseSpeed] = useState(19) // 19, 18.5, 18 km/h
  const [cruiseDirection, setCruiseDirection] = useState('W') // 'W', 'E', 'N', 'S'
  const [cruiseStats, setCruiseStats] = useState({ count: 0, distanceM: 0, lastPerturbed: false })

  const cruiseRef = useRef({
    active: false,
    id: null,
    lat: 0,
    lng: 0,
    name: '',
    count: 0,
    distanceM: 0,
    speed: 19,
    direction: 'W'
  })

  const { status, loading, refresh } = useDeviceStatus()

  const activeCoord = coordinates.find((c) => c.id === activeId) ?? null

  // appliedCoord is deliberately not persisted: the simulated location dies with
  // the bridge's DVT session, so restoring it would show a location the phone is
  // no longer reporting.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(coordinates))
    } catch {
      // Quota exceeded or storage blocked — the list still works for this session.
    }
  }, [coordinates])

  const notify = (type, text) => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 5000)
  }

  // 航向切換處理（支援巡航中即時切換）
  const changeCruiseDirection = useCallback((dir) => {
    if (!CRUISE_DIRECTIONS[dir]) return
    setCruiseDirection(dir)
    cruiseRef.current.direction = dir
    notify('info', `🧭 航向已切換為：${CRUISE_DIRECTIONS[dir].fullLabel} (${CRUISE_DIRECTIONS[dir].arrow})`)
  }, [])

  // 速度切換處理（支援巡航中即時切換 19, 18.5, 18 km/h）
  const changeCruiseSpeed = useCallback((speed) => {
    setCruiseSpeed(speed)
    cruiseRef.current.speed = speed
    notify('info', `⚡ 巡航時速已調整為：${speed} km/h`)
  }, [])

  // 實體鍵盤方向鍵監聽（ArrowUp / ArrowDown / ArrowLeft / ArrowRight）
  useEffect(() => {
    const handleKeyDown = (e) => {
      // 避免在文字輸入框打字時誤觸航向變更
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        changeCruiseDirection('N')
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        changeCruiseDirection('S')
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        changeCruiseDirection('W')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        changeCruiseDirection('E')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [changeCruiseDirection])

/**
 * Reverse geocodes lat/lng via OpenStreetMap Nominatim to find a nearby place or road name.
 */
async function fetchReverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
    )
    if (!res.ok) return ''
    const data = await res.json()
    if (!data) return ''

    const addr = data.address || {}
    const placeName =
      data.name ||
      addr.amenity ||
      addr.building ||
      addr.shop ||
      addr.tourism ||
      addr.historic ||
      addr.leisure ||
      addr.office ||
      addr.road ||
      data.display_name?.split(',')[0] ||
      ''

    return placeName.trim()
  } catch {
    return ''
  }
}

  const handleCoordinateSelect = async (coord) => {
    const lat = coord.lat
    const lng = wrapLongitude(coord.lng)
    const newId = nextId()
    const point = { id: newId, name: '', lat, lng }
    setCoordinates((prev) => [...prev, point])
    setActiveId(newId)
    setInputLat(lat.toString())
    setInputLng(lng.toString())
    setMapCenter([lat, lng])

    // Background reverse geocoding to pre-fill nearby place name
    const placeName = await fetchReverseGeocode(lat, lng)
    if (placeName) {
      setCoordinates((prev) =>
        prev.map((c) => (c.id === newId && !c.name ? { ...c, name: placeName } : c))
      )
    }
  }

  // Tags commit as you type. Unlike the coordinate fields there is nothing to
  // parse, so staging the value behind 「更新座標」 would only lose edits.
  const handleRenameCoordinate = (id, name) => {
    setCoordinates((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)))
  }

  const handleUpdateCoordinate = () => {
    if (!activeCoord || inputLat === '' || inputLng === '') return

    const lat = parseFloat(inputLat)
    const rawLng = parseFloat(inputLng)
    if (!Number.isFinite(lat) || !Number.isFinite(rawLng)) {
      notify('error', '請輸入有效的數值座標')
      return
    }

    if (lat < -90 || lat > 90) {
      notify('error', '緯度必須介於 -90 至 90 度之間')
      return
    }

    let lng = rawLng
    if (lng < -180 || lng > 180) {
      lng = wrapLongitude(lng)
      setInputLng(lng.toString())
      notify('info', `經度超出範圍，已自動調整至 [-180, 180]：${lng.toFixed(6)}`)
    }

    setCoordinates((prev) => prev.map((c) => (c.id === activeId ? { ...c, lat, lng } : c)))
    setMapCenter([lat, lng])
  }

  const handleQuickSearchOrAdd = async (e) => {
    if (e) e.preventDefault()
    if (!searchQuery.trim()) return

    const trimmed = searchQuery.trim()
    // Match Lat, Lng format e.g. "37.7749, -122.4194" or "-33.8688 151.2093" or "37.7749/-122.4194"
    const coordMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*[\s,;/]\s*(-?\d+(?:\.\d+)?)$/)
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1])
      const rawLng = parseFloat(coordMatch[2])
      if (Number.isFinite(lat) && Number.isFinite(rawLng) && Math.abs(lat) <= 90) {
        const lng = wrapLongitude(rawLng)
        const newId = nextId()
        const newPoint = { id: newId, lat, lng, name: '' }
        setCoordinates((prev) => [...prev, newPoint])
        setActiveId(newPoint.id)
        setInputLat(lat.toString())
        setInputLng(lng.toString())
        setMapCenter([lat, lng])
        setSearchQuery('')
        notify('success', `已新增並跳轉至座標 (${lat.toFixed(5)}, ${lng.toFixed(5)})`)

        fetchReverseGeocode(lat, lng).then((placeName) => {
          if (placeName) {
            setCoordinates((prev) =>
              prev.map((c) => (c.id === newId && !c.name ? { ...c, name: placeName } : c))
            )
          }
        })
        return
      }
    }

    // Geocoding fallback using OpenStreetMap Nominatim
    setSearching(true)
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(trimmed)}`)
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0]
        const lat = parseFloat(first.lat)
        const lng = wrapLongitude(parseFloat(first.lon))
        const name = first.display_name.split(',')[0]
        const newPoint = { id: nextId(), lat, lng, name }
        setCoordinates((prev) => [...prev, newPoint])
        setActiveId(newPoint.id)
        setInputLat(lat.toString())
        setInputLng(lng.toString())
        setMapCenter([lat, lng])
        setSearchQuery('')
        notify('success', `已定位地點：${name} (${lat.toFixed(4)}, ${lng.toFixed(4)})`)
      } else {
        notify('error', '找不到該地點或座標格式無效（例：37.7749, -122.4194）')
      }
    } catch {
      notify('error', '地點搜尋失敗，請檢查網路連線')
    } finally {
      setSearching(false)
    }
  }

  const stopCruise = useCallback((reason = '已停止巡航') => {
    cruiseRef.current.active = false
    setIsCruising(false)
    setCruisingCoordId(null)
    setCruiseStats((prev) => ({ ...prev, lastPerturbed: false }))
    if (reason) notify('info', reason)
  }, [])

  const toggleCruise = () => {
    if (isCruising) {
      const { distanceM, count, direction, speed } = cruiseRef.current
      const dirLabel = CRUISE_DIRECTIONS[direction]?.fullLabel || '巡航'
      stopCruise(`已取消${dirLabel}（累計移動約 ${distanceM.toFixed(1)} 公尺，更新 ${count} 次）`)
      return
    }

    if (!activeCoord) {
      notify('error', '請先選取一個地點')
      return
    }

    const lat = activeCoord.lat
    const lng = activeCoord.lng
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      notify('error', '選取的座標無效')
      return
    }

    cruiseRef.current = {
      active: true,
      id: activeCoord.id,
      lat,
      lng,
      name: activeCoord.name?.trim() || '',
      count: 0,
      distanceM: 0,
      speed: cruiseSpeed,
      direction: cruiseDirection
    }
    setCruisingCoordId(activeCoord.id)
    setCruiseStats({ count: 0, distanceM: 0, lastPerturbed: false })
    setIsCruising(true)
    notify('success', `🧭 已啟動巡航（${CRUISE_DIRECTIONS[cruiseDirection]?.fullLabel || '向西'} ${cruiseSpeed} km/h，每 2 秒更新，每 6 秒 ±5m 垂直擾動）`)

    if (status?.ready) {
      sendToDevice(lat, lng, activeCoord.name?.trim())
    }
  }

  // 巡航定時器：每 2 秒依指定航向與時速更新新位置，每 6 秒產生 5 米垂直擾動
  useEffect(() => {
    if (!isCruising) return

    const intervalId = setInterval(async () => {
      const currentCruise = cruiseRef.current
      if (!currentCruise.active) return

      const { id, lat, lng, name, count, distanceM, speed, direction } = currentCruise
      const newCount = count + 1

      // 每 6 秒 (每 3 步) 產生一次垂直分量 5 公尺擾動 (+5m 與 -5m 交替擺盪)
      const applyPerturbation = newCount % 3 === 0
      const perturbationSign = (Math.floor(newCount / 3) % 2 === 1) ? 1 : -1

      const step = calculateCruiseStep(
        lat,
        lng,
        speed || 19,
        2,
        direction || 'W',
        applyPerturbation,
        perturbationSign,
        5
      )

      const newDistanceM = distanceM + step.mainDistanceM

      // 更新 ref
      cruiseRef.current.lat = step.lat
      cruiseRef.current.lng = step.lng
      cruiseRef.current.count = newCount
      cruiseRef.current.distanceM = newDistanceM

      // 更新巡航統計 state
      setCruiseStats({
        count: newCount,
        distanceM: newDistanceM,
        lastPerturbed: applyPerturbation
      })

      // 更新座標列表
      setCoordinates((prev) =>
        prev.map((c) => (c.id === id ? { ...c, lat: step.lat, lng: step.lng } : c))
      )

      // 若目前選中編輯的即為該巡航點，同步更新經緯度輸入框
      if (activeId === id) {
        setInputLat(step.lat.toFixed(6))
        setInputLng(step.lng.toFixed(6))
      }

      // 地圖中心跟隨更新
      setMapCenter([step.lat, step.lng])

      // 若 iPhone 已就緒，傳送至裝置
      if (status?.ready) {
        try {
          const res = await fetch('/api/location', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: step.lat, lng: step.lng })
          })
          const data = await res.json()
          if (data.ok) {
            const dirInfo = CRUISE_DIRECTIONS[direction] || CRUISE_DIRECTIONS.W
            setAppliedCoord({
              lat: step.lat,
              lng: step.lng,
              label: name
                ? `${name} (${dirInfo.fullLabel} ${speed}km/h)`
                : `巡航中 (${dirInfo.fullLabel} ${speed}km/h)`
            })
          }
        } catch {
          // 靜默捕捉，不干擾巡航計時
        }
      }
    }, 2000)

    return () => {
      clearInterval(intervalId)
    }
  }, [isCruising, activeId, status?.ready])

  const handleDeleteCoordinate = (id) => {
    if (cruiseRef.current.active && cruiseRef.current.id === id) {
      stopCruise('巡航地點已被刪除，已取消巡航')
    }
    setCoordinates((prev) => prev.filter((c) => c.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setInputLat('')
      setInputLng('')
    }
  }

  const handleSelectForEdit = (coord) => {
    setActiveId(coord.id)
    setInputLat(coord.lat.toString())
    setInputLng(coord.lng.toString())
    setMapCenter([coord.lat, coord.lng])
  }

  const handleJumpToLocation = (coord) => {
    setMapCenter([coord.lat, coord.lng])
  }

  const sendToDevice = async (lat, lng, label) => {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      notify('error', '緯度必須介於 -90 至 90 度之間')
      return
    }

    let validLng = lng
    if (!Number.isFinite(validLng) || validLng < -180 || validLng > 180) {
      validLng = wrapLongitude(validLng)
    }

    setSending(true)
    try {
      const res = await fetch('/api/location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lng: validLng })
      })
      const data = await res.json()
      if (res.ok) {
        const coords = `${lat.toFixed(5)}, ${validLng.toFixed(5)}`
        setAppliedCoord({ lat, lng: validLng, label })
        notify('success', `已將 iPhone 定位設為 ${label ? `${label}（${coords}）` : coords}`)
      } else {
        notify('error', data.error?.message || '傳送失敗')
      }
    } catch {
      notify('error', '無法連線到 bridge，請確認 npm run server 已啟動')
    } finally {
      setSending(false)
      refresh(true)
    }
  }

  const clearDeviceLocation = async () => {
    setSending(true)
    try {
      const res = await fetch('/api/location/clear', { method: 'POST' })
      const data = await res.json()
      if (res.ok) {
        setAppliedCoord(null)
        notify('success', '已還原為真實 GPS')
      } else {
        notify('error', data.error?.message || '還原失敗')
      }
    } catch {
      notify('error', '無法連線到 bridge')
    } finally {
      setSending(false)
    }
  }

  const mountDdi = async () => {
    setMounting(true)
    notify('info', '正在下載並掛載 Developer Disk Image，可能需要數分鐘…')
    try {
      const res = await fetch('/api/ddi/mount', { method: 'POST' })
      const data = await res.json()
      if (res.ok) notify('success', 'DDI 掛載完成')
      else notify('error', data.error?.message || 'DDI 掛載失敗')
    } catch {
      notify('error', '無法連線到 bridge')
    } finally {
      setMounting(false)
      refresh(true)
    }
  }

  const deviceReady = !!status?.ready

  return (
    <div className="app-container">
      <div className="app-header">
        <div>
          <h1>🗺️ GPS Location Editor for Apple Devices</h1>
          <p className="subtitle">點擊地圖選取座標，透過 USB 傳送到 iPhone</p>
        </div>
      </div>

      {toast && <div className={`toast toast-${toast.type}`}>{toast.text}</div>}

      <div className="app-layout">
        <div className="map-section">
          <MapContainer center={mapCenter} zoom={11} className="map-container" worldCopyJump={true}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution='&copy; OpenStreetMap contributors'
            />
            <MapClick onCoordinateSelect={handleCoordinateSelect} />
            <Recenter center={mapCenter} />
            {coordinates.map((coord, idx) => {
              const isThisCruising = isCruising && cruisingCoordId === coord.id
              const curDir = CRUISE_DIRECTIONS[cruiseDirection] || CRUISE_DIRECTIONS.W
              return (
                <Marker
                  key={coord.id}
                  position={[coord.lat, coord.lng]}
                  icon={coord.id === activeId ? redIcon : defaultIcon}
                >
                  <Popup>
                    <div className="popup-body">
                      <div className="popup-header-row">
                        <strong>{labelOf(coord, idx)}</strong>
                        {isThisCruising && (
                          <span className="badge-cruising">
                            {curDir.arrow} {cruiseSpeed}km/h
                          </span>
                        )}
                      </div>
                      <p>Lat: {coord.lat.toFixed(6)}</p>
                      <p>Lng: {coord.lng.toFixed(6)}</p>
                      <button
                        className="btn-primary btn-popup"
                        disabled={!deviceReady || sending}
                        onClick={() => sendToDevice(coord.lat, coord.lng, coord.name.trim())}
                      >
                        📲 傳送到 iPhone
                      </button>
                      <button
                        className={`btn-popup btn-cruise-inline ${isThisCruising ? 'btn-cruise-active' : 'btn-cruise-start'}`}
                        onClick={() => {
                          if (coord.id !== activeId) {
                            handleSelectForEdit(coord)
                          }
                          toggleCruise()
                        }}
                      >
                        {isThisCruising
                          ? `⏹️ 取消巡航 (${curDir.arrow} ${cruiseSpeed}km/h)`
                          : `🧭 啟動${curDir.fullLabel}巡航 (${cruiseSpeed} km/h)`}
                      </button>
                    </div>
                  </Popup>
                </Marker>
              )
            })}
          </MapContainer>
        </div>

        <div className="control-panel">
          <DevicePanel
            status={status}
            loading={loading}
            onRefresh={refresh}
            onMountDdi={mountDdi}
            busy={mounting}
          />

          {appliedCoord && (
            <div className="applied-banner">
              <span>📍 目前模擬位置</span>
              {appliedCoord.label && <strong>{appliedCoord.label}</strong>}
              <code>{appliedCoord.lat.toFixed(5)}, {appliedCoord.lng.toFixed(5)}</code>
              <button className="btn-inline" onClick={clearDeviceLocation} disabled={sending}>
                還原真實 GPS
              </button>
            </div>
          )}

          <div className="search-section">
            <form onSubmit={handleQuickSearchOrAdd} className="search-form">
              <input
                type="text"
                placeholder="搜尋地點或貼上座標 (如 37.7749, -122.4194)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <button type="submit" className="btn-secondary btn-search" disabled={searching}>
                {searching ? '搜尋中…' : '🔍 新增 / 跳轉'}
              </button>
            </form>
          </div>

          <div className="locations-list">
            <h2>📍 Saved Locations</h2>
            <div className="locations-scroll">
              {coordinates.length === 0 ? (
                <p className="empty-state">點擊地圖以新增位置</p>
              ) : (
                coordinates.map((coord, idx) => {
                  const isThisCruising = isCruising && cruisingCoordId === coord.id
                  const curDir = CRUISE_DIRECTIONS[cruiseDirection] || CRUISE_DIRECTIONS.W
                  return (
                    <div
                      key={coord.id}
                      className={`location-item ${coord.id === activeId ? 'active' : ''} ${isThisCruising ? 'cruising-item' : ''}`}
                    >
                      <div className="location-info" onClick={() => handleSelectForEdit(coord)}>
                        <div className="location-title-row">
                          <strong className={coord.name.trim() ? 'has-tag' : 'no-tag'}>
                            {labelOf(coord, idx)}
                          </strong>
                          {isThisCruising && (
                            <span className="badge-cruising">
                              {curDir.arrow} {cruiseSpeed}km/h 巡航中
                            </span>
                          )}
                        </div>
                        <p className="coord-text">{coord.lat.toFixed(5)}, {coord.lng.toFixed(5)}</p>
                      </div>
                      <div className="location-actions">
                        <button
                          className="btn-small btn-send"
                          onClick={() => sendToDevice(coord.lat, coord.lng, coord.name.trim())}
                          disabled={!deviceReady || sending}
                          title={deviceReady ? '傳送到 iPhone' : '裝置尚未就緒'}
                        >
                          📲
                        </button>
                        <button
                          className="btn-small btn-jump"
                          onClick={() => handleJumpToLocation(coord)}
                          title="移動地圖到此位置"
                        >
                          🎯
                        </button>
                        <button
                          className="btn-small btn-delete"
                          onClick={() => handleDeleteCoordinate(coord.id)}
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="editor-section">
            <h2>✏️ Edit Location</h2>
            {activeCoord ? (
              <div className="editor-form">
                <div className="form-group">
                  <label>🏷️ 地名 TAG</label>
                  <input
                    type="text"
                    value={activeCoord.name}
                    onChange={(e) => handleRenameCoordinate(activeCoord.id, e.target.value)}
                    placeholder="公司、家、機場…"
                    maxLength={40}
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Latitude (-90 to 90)</label>
                    <input
                      type="number"
                      step="0.000001"
                      min="-90"
                      max="90"
                      value={inputLat}
                      onChange={(e) => setInputLat(e.target.value)}
                      placeholder="25.033000"
                    />
                  </div>
                  <div className="form-group">
                    <label>Longitude (-180 to 180)</label>
                    <input
                      type="number"
                      step="0.000001"
                      min="-180"
                      max="180"
                      value={inputLng}
                      onChange={(e) => setInputLng(e.target.value)}
                      placeholder="121.565400"
                    />
                  </div>
                </div>

                <div className="action-button-row">
                  <button type="button" className="btn-secondary" onClick={handleUpdateCoordinate}>
                    更新座標
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={!deviceReady || sending}
                    onClick={() => sendToDevice(
                      parseFloat(inputLat),
                      parseFloat(inputLng),
                      activeCoord.name.trim()
                    )}
                  >
                    {sending ? '傳送中…' : '📲 傳送到 iPhone'}
                  </button>
                </div>

                {/* 速度切換選項：19, 18.5, 18 km/h */}
                <div className="cruise-config-block">
                  <div className="config-label-row">
                    <span className="config-title">⚡ 巡航時速</span>
                    <span className="config-badge">{cruiseSpeed} km/h</span>
                  </div>
                  <div className="speed-selector-group">
                    {CRUISE_SPEEDS.map((spd) => (
                      <button
                        key={spd}
                        type="button"
                        className={`btn-speed-option ${cruiseSpeed === spd ? 'active' : ''}`}
                        onClick={() => changeCruiseSpeed(spd)}
                      >
                        {spd} km/h
                      </button>
                    ))}
                  </div>
                </div>

                {/* 航向控制盤：東西南北 + 方向鍵快捷提示 */}
                <div className="cruise-config-block">
                  <div className="config-label-row">
                    <span className="config-title">🧭 航向設定 (方向鍵 ↑↓←→)</span>
                    <span className="config-badge">
                      {CRUISE_DIRECTIONS[cruiseDirection]?.fullLabel} ({cruiseDirection})
                    </span>
                  </div>
                  <div className="dpad-container">
                    <div className="dpad-row dpad-center">
                      <button
                        type="button"
                        className={`btn-dpad ${cruiseDirection === 'N' ? 'active' : ''}`}
                        onClick={() => changeCruiseDirection('N')}
                        title="向北 (鍵盤 ArrowUp)"
                      >
                        ⬆️ 北
                      </button>
                    </div>
                    <div className="dpad-row dpad-middle">
                      <button
                        type="button"
                        className={`btn-dpad ${cruiseDirection === 'W' ? 'active' : ''}`}
                        onClick={() => changeCruiseDirection('W')}
                        title="向西 (鍵盤 ArrowLeft)"
                      >
                        ⬅️ 西
                      </button>
                      <div className="dpad-compass-core" title="目前航向">
                        {CRUISE_DIRECTIONS[cruiseDirection]?.arrow}
                      </div>
                      <button
                        type="button"
                        className={`btn-dpad ${cruiseDirection === 'E' ? 'active' : ''}`}
                        onClick={() => changeCruiseDirection('E')}
                        title="向東 (鍵盤 ArrowRight)"
                      >
                        東 ➡️
                      </button>
                    </div>
                    <div className="dpad-row dpad-center">
                      <button
                        type="button"
                        className={`btn-dpad ${cruiseDirection === 'S' ? 'active' : ''}`}
                        onClick={() => changeCruiseDirection('S')}
                        title="向南 (鍵盤 ArrowDown)"
                      >
                        ⬇️ 南
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className={`btn-cruise ${isCruising ? 'btn-cruise-active' : 'btn-cruise-start'}`}
                  onClick={toggleCruise}
                >
                  {isCruising ? (
                    <>
                      <span className="cruise-pulse-dot" />
                      ⏹️ 取消巡航 ({CRUISE_DIRECTIONS[cruiseDirection]?.arrow} {cruiseSpeed}km/h · {cruiseStats.distanceM.toFixed(0)}m)
                    </>
                  ) : (
                    <>
                      🧭 啟動{CRUISE_DIRECTIONS[cruiseDirection]?.fullLabel}巡航 ({cruiseSpeed} km/h · 每2秒更新)
                    </>
                  )}
                </button>

                {isCruising && (
                  <div className="cruise-status-panel">
                    <div className="cruise-status-header">
                      <span className="cruise-status-indicator">
                        ● {CRUISE_DIRECTIONS[cruiseDirection]?.arrow} {CRUISE_DIRECTIONS[cruiseDirection]?.fullLabel}巡航中
                      </span>
                      <span className="cruise-status-speed">{cruiseSpeed} km/h</span>
                    </div>
                    <div className="cruise-status-details">
                      <div className="status-detail-line">
                        <span>步進週期：</span>
                        <span>2 秒一次（約 {((cruiseSpeed * 1000 / 3600) * 2).toFixed(1)}m）</span>
                      </div>
                      <div className="status-detail-line">
                        <span>累計位移：</span>
                        <span>約 {cruiseStats.distanceM.toFixed(1)} 公尺（更新 {cruiseStats.count} 次）</span>
                      </div>
                      <div className="status-detail-line status-perturb-line">
                        <span>垂直擾動：</span>
                        <span className={`perturb-pill ${cruiseStats.lastPerturbed ? 'perturb-active' : ''}`}>
                          ±5m (每 6 秒觸發{cruiseStats.lastPerturbed ? '⚡' : ''})
                        </span>
                      </div>
                    </div>
                    <div className="cruise-hint">
                      💡 巡航中隨時按方向鍵 ↑ ↓ ← → 或點擊切換航向
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="empty-state">選擇一個位置以編輯</p>
            )}
          </div>

          <div className="export-section">
            <button
              className="btn-secondary"
              onClick={() => {
                const data = JSON.stringify(coordinates, null, 2)
                const blob = new Blob([data], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'gps-locations.json'
                a.click()
                URL.revokeObjectURL(url)
              }}
              disabled={coordinates.length === 0}
            >
              📤 匯出 JSON
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
