import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, ZoomControl } from 'react-leaflet'
import { STORES, PRODUCTS } from './data.js'
import STORES_ALL_RAW from './stores.all.json'
import { useLocalState, useNotifications, useLatest } from './hooks.js'

// Cap on tracked favorites. Each favorite becomes an anchor on refresh,
// so this also caps the per-refresh API call count.
const MAX_FAVORITES = 30

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENDPOINT = '/api/inventory/storeNearby'

// Polling intervals in milliseconds. "Manual" means no auto-refresh.
const INTERVALS = [
  { key: 'manual', label: 'Manual',  ms: 0 },
  { key: '2h',     label: 'Every 2h', ms: 2 * 60 * 60 * 1000 },
  { key: '4h',     label: 'Every 4h', ms: 4 * 60 * 60 * 1000 },
  { key: '8h',     label: 'Every 8h', ms: 8 * 60 * 60 * 1000 },
]

const stockColor = (qty) => {
  if (qty == null || qty === '?' || qty === '—') return '#8a7a62'
  const n = Number(qty)
  if (Number.isNaN(n)) return '#8a7a62'
  if (n <= 0)  return '#6b2424'
  if (n < 3)   return '#f59e0b'   // 1-2  low
  if (n < 6)   return '#facc15'   // 3-5  some
  return '#a3e635'                // 6+   plenty
}

const stockLabel = (qty) => {
  if (qty == null || qty === '?' || qty === '—') return 'unknown'
  const n = Number(qty)
  if (Number.isNaN(n)) return String(qty)
  if (n <= 0) return 'out'
  return `${n} in stock`
}

const qtyNum = (q) => {
  const n = Number(q)
  return Number.isFinite(n) ? n : null
}

// Great-circle distance in miles. Good enough for sorting; we're not navigating.
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8
  const toRad = (d) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

const normStoreNum = (s) => String(s ?? '').replace(/^0+/, '') || '0'

async function fetchWithRetry(url) {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } })
    if (res.ok) return res.json()

    const retriable = res.status === 429 || res.status === 503
    if (!retriable || attempt === maxAttempts) {
      throw new Error(`HTTP ${res.status}`)
    }

    const retryAfter = res.headers.get('Retry-After')
    let waitMs
    if (retryAfter) {
      const secs = Number(retryAfter)
      waitMs = Number.isFinite(secs)
        ? secs * 1000
        : Math.max(0, new Date(retryAfter).getTime() - Date.now())
    }
    if (!waitMs || !Number.isFinite(waitMs)) {
      waitMs = 500 * 2 ** attempt + Math.random() * 500
    }
    await new Promise(r => setTimeout(r, waitMs))
  }
}

// Pull a value from the first matching key in a record.
const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k]
    if (v != null && v !== '') return v
  }
  return undefined
}

// Extract { num, label, address, lat, lon } from a store record returned
// by storeNearby. Coordinates may be missing on some records — callers
// should treat them as optional.
function metaFromInfo(info) {
  const num = String(info?.storeId ?? '').replace(/^0+/, '') || null
  if (!num) return null
  const lat = Number(pick(info, 'latitude', 'lat'))
  const lon = Number(pick(info, 'longitude', 'lng', 'lon'))
  const city = pick(info, 'city', 'storeCity') || ''
  return {
    num,
    label: pick(info, 'storeName', 'name', 'displayName') || city || `Store #${num}`,
    address: pick(info, 'address1', 'streetAddress', 'address') || '',
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  }
}

// Fan out across anchor stores. The storeNearby endpoint returns at most
// 6 stores per call, so we iterate our tracked stores as anchors and stop
// once every tracked store has been covered by some response.
async function fetchInventory(storeNums, productCodes) {
  if (!storeNums.length || !productCodes.length) return { rows: [], discovered: {} }
  const seen = new Set()   // `${store}|${code}` — dedupe across overlapping responses
  const rows = []
  const discovered = {}    // storeNum -> { num, label, address, lat, lon }
  for (const code of productCodes) {
    const needed = new Set(storeNums.map(normStoreNum))
    for (const store of storeNums) {
      if (needed.size === 0) break
      if (!needed.has(normStoreNum(store))) continue
      const params = new URLSearchParams({
        storeNumber: store,
        productCode: code,
        mileRadius: '999',
        storeCount: '5',
        buffer: '0',
      })
      const data = await fetchWithRetry(`${ENDPOINT}?${params}`)
      // Response shape:
      //   { products: [{ productId, storeInfo: {...}, nearbyStores: [{...}] }] }
      const products = Array.isArray(data?.products) ? data.products : []
      for (const prod of products) {
        const prodCode = String(prod.productId ?? code)
        const entries = [prod.storeInfo, ...(prod.nearbyStores ?? [])]
        for (const info of entries) {
          if (!info) continue
          const rowStore = normStoreNum(info.storeId)
          if (!rowStore) continue
          needed.delete(rowStore)
          if (!discovered[rowStore]) {
            const meta = metaFromInfo(info)
            if (meta) discovered[rowStore] = meta
          }
          const key = `${rowStore}|${prodCode}`
          if (seen.has(key)) continue
          seen.add(key)
          rows.push({
            storeNumber: rowStore,
            productCode: prodCode,
            quantity: info.quantity,
          })
        }
      }
    }
  }
  return { rows, discovered }
}

function indexInventory(payload) {
  const rows = Array.isArray(payload) ? payload : (payload?.data ?? payload?.Data ?? [])
  const out = {}
  for (const r of rows) {
    const store = String(r.storeNumber ?? r.StoreNumber ?? r.store ?? r.Store ?? '').replace(/^0+/, '') || '0'
    const code  = String(r.productCode ?? r.ProductCode ?? r.product ?? r.Product ?? '')
    const qty   = r.quantity ?? r.Quantity ?? r.inventory ?? r.Inventory ?? r.qty ?? r.availableQuantity ?? null
    if (!store || !code) continue
    if (!out[store]) out[store] = {}
    out[store][code] = qty
  }
  return out
}

/**
 * Compare two inventory snapshots and return an array of transitions
 * where a product went from 0 (or missing/unknown) to in-stock.
 */
function findNewlyInStock(previous, current, stores, products) {
  const hits = []
  for (const s of stores) {
    const key = s.num.replace(/^0+/, '')
    const before = previous?.[key] || {}
    const now    = current?.[key] || {}
    for (const p of products) {
      const prevQty = qtyNum(before[p.code])
      const nowQty  = qtyNum(now[p.code])
      // "newly in stock" = currently has > 0 AND previously was 0
      // (we require a known previous value of 0 to avoid spamming on first load)
      if (nowQty != null && nowQty > 0 && prevQty === 0) {
        hits.push({ store: s, product: p, qty: nowQty })
      }
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProductPicker({ products, activeCodes, onToggle }) {
  const [open, setOpen] = useState(false)
  const selectedCount = activeCodes.size
  return (
    <div className={`products ${open ? 'products--open' : ''}`}>
      <button
        type="button"
        className="products__summary"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-controls="product-chips"
      >
        <span className="products__summary-label">Tracking</span>
        <span className="products__summary-count">
          {selectedCount} of {products.length}
        </span>
        <span className="products__caret" aria-hidden="true">▾</span>
      </button>
      <div className="products__label">TRACKING</div>
      <div id="product-chips" className="products__chips">
        {products.map(p => {
          const on = activeCodes.has(p.code)
          return (
            <button
              key={p.code}
              type="button"
              className={`chip ${on ? 'chip--on' : ''}`}
              onClick={() => onToggle(p.code)}
              title={`Code ${p.code}`}
            >
              <span className="chip__dot" />
              {p.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function StoreRow({ store, inventory, activeProducts, distance, isFavorite, selected, onSelect, onToggleFavorite }) {
  const storeInv = inventory[store.num.replace(/^0+/, '')] || {}
  const total = activeProducts.reduce((sum, p) => {
    const n = Number(storeInv[p.code])
    return Number.isFinite(n) && n > 0 ? sum + n : sum
  }, 0)
  // Show in-stock products first, descending by quantity. Stable sort
  // keeps the original product order within ties (incl. all the zeros).
  const sortedProducts = [...activeProducts].sort((a, b) => {
    const na = Number(storeInv[a.code]); const nb = Number(storeInv[b.code])
    return (Number.isFinite(nb) ? nb : 0) - (Number.isFinite(na) ? na : 0)
  })

  return (
    <div
      className={`store ${selected ? 'store--selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect() }
      }}
    >
      <div className="store__head">
        <span className="store__num">#{store.num}</span>
        <span className="store__name">{store.label}</span>
        {distance != null && (
          <span className="store__dist">{distance.toFixed(1)} mi</span>
        )}
        <span
          className="store__total"
          style={{ color: total === 0 ? '#6b5a48' : '#e7d9bb' }}
        >
          {total} btl
        </span>
        {onToggleFavorite && (
          <button
            type="button"
            className={`store__star ${isFavorite ? 'store__star--on' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleFavorite() }}
            aria-pressed={isFavorite}
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            ★
          </button>
        )}
      </div>
      <div className="store__addr">{store.address}</div>
      <div className="store__bars">
        {sortedProducts.map(p => {
          const qty = storeInv[p.code]
          const n = Number(qty)
          const pct = Number.isFinite(n) && n > 0 ? Math.min(100, n * 8) : 0
          return (
            <div key={p.code} className="bar" title={`${p.name}: ${stockLabel(qty)}`}>
              <span className="bar__label">{p.name.replace(/ \d+(ml|L)$/, '')}</span>
              <span className="bar__track">
                <span
                  className="bar__fill"
                  style={{
                    width: `${pct}%`,
                    background: stockColor(qty),
                  }}
                />
              </span>
              <span className="bar__qty">{qty ?? '—'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Format a ms duration like "3h 12m" or "4m"
function formatCountdown(ms) {
  if (ms <= 0) return '0s'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.ceil(ms / 1000)}s`
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  // --- Persisted config ---------------------------------------------------
  const [activeCodesArr, setActiveCodesArr] = useLocalState(
    'bt.activeCodes',
    PRODUCTS.filter(p => p.defaultOn).map(p => p.code),
  )
  const activeCodes = useMemo(() => new Set(activeCodesArr), [activeCodesArr])
  const [intervalKey, setIntervalKey] = useLocalState('bt.interval', '4h')
  const [notifyEnabled, setNotifyEnabled] = useLocalState('bt.notify', false)
  // Favorites bootstrap to the curated short-list so existing users see
  // the same stores they used to. They can star/unstar anything.
  const [favoriteNumsArr, setFavoriteNumsArr] = useLocalState(
    'bt.favorites',
    STORES.map(s => s.num),
  )
  const favoriteNums = useMemo(() => new Set(favoriteNumsArr), [favoriteNumsArr])

  // --- Runtime state ------------------------------------------------------
  const [inventory, setInventory] = useState({})
  // Discovered stores (harvested from API responses) survive reloads so
  // a starred store doesn't vanish if it isn't in the static directory.
  const [discoveredStores, setDiscoveredStores] = useLocalState('bt.discovered', {})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastChecked, setLastChecked] = useState(null)
  const [selectedStore, setSelectedStore] = useState(null)
  const [mobileView, setMobileView] = useState('list')
  const [userLoc, setUserLoc] = useState(null)        // { lat, lon } | null
  const [locStatus, setLocStatus] = useState('idle')  // 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable'
  const [now, setNow] = useState(() => Date.now())
  const prevInventoryRef = useRef({})
  const inFlightRef = useRef(false)
  const mapRef = useRef(null)

  const { status: notifStatus, request: requestNotif, send: sendNotif } = useNotifications()

  const activeProducts = useMemo(
    () => PRODUCTS.filter(p => activeCodes.has(p.code)),
    [activeCodes]
  )
  const activeProductsRef = useLatest(activeProducts)
  const notifyEnabledRef   = useLatest(notifyEnabled)

  const toggleCode = (code) => {
    setActiveCodesArr(prev => {
      const has = prev.includes(code)
      return has ? prev.filter(c => c !== code) : [...prev, code]
    })
  }

  const toggleFavorite = useCallback((num) => {
    setFavoriteNumsArr(prev => {
      if (prev.includes(num)) return prev.filter(n => n !== num)
      if (prev.length >= MAX_FAVORITES) {
        setError(`Favorites are capped at ${MAX_FAVORITES}. Unstar one first.`)
        return prev
      }
      return [...prev, num]
    })
  }, [setFavoriteNumsArr])

  // Every store we know about, keyed by num. Curated short-list seeds it,
  // the static directory (after running scripts/fetch-stores.mjs) augments,
  // and stores discovered at runtime via storeNearby fill in anything else.
  const knownStores = useMemo(() => {
    const m = new Map()
    for (const s of STORES) m.set(s.num, s)
    if (Array.isArray(STORES_ALL_RAW)) {
      for (const s of STORES_ALL_RAW) m.set(s.num, s)
    }
    for (const [num, meta] of Object.entries(discoveredStores)) {
      if (!m.has(num)) m.set(num, meta)
    }
    return m
  }, [discoveredStores])

  const favoriteStores = useMemo(() => {
    return favoriteNumsArr.map(n => knownStores.get(n)).filter(Boolean)
  }, [favoriteNumsArr, knownStores])

  // Anchor selection for fetchInventory. Without a location we fan out
  // across favorites (capped at MAX_FAVORITES). With a location we use
  // the single closest store we know about — the storeNearby response
  // then radiates outward with up to 5 stores' worth of inventory.
  const anchorNums = useMemo(() => {
    const fanOut = favoriteStores.length > 0 ? favoriteStores : STORES
    if (!userLoc) return fanOut.map(s => s.num)
    const candidates = [...knownStores.values()].filter(
      s => s.lat != null && s.lon != null
    )
    const pool = candidates.length > 0 ? candidates : STORES
    const closest = [...pool].sort((a, b) =>
      distanceMiles(userLoc.lat, userLoc.lon, a.lat, a.lon) -
      distanceMiles(userLoc.lat, userLoc.lon, b.lat, b.lon)
    )[0]
    return closest ? [closest.num] : fanOut.map(s => s.num)
  }, [userLoc, favoriteStores, knownStores])

  // --- The core fetch -----------------------------------------------------
  const refresh = useCallback(async () => {
    if (activeCodes.size === 0) return
    if (inFlightRef.current) return
    inFlightRef.current = true
    setLoading(true)
    setError(null)
    try {
      const { rows, discovered } = await fetchInventory(
        anchorNums,
        [...activeCodes],
      )
      const next = indexInventory(rows)
      if (Object.keys(discovered).length) {
        setDiscoveredStores(prev => ({ ...prev, ...discovered }))
      }

      // Detect transitions and notify
      const previous = prevInventoryRef.current
      const hits = findNewlyInStock(previous, next, STORES, activeProductsRef.current)
      if (hits.length > 0 && notifyEnabledRef.current && notifStatus === 'granted') {
        if (hits.length === 1) {
          const { store, product, qty } = hits[0]
          sendNotif(
            `🥃 ${product.name} back in stock`,
            `Store #${store.num} — ${store.label} (${qty} bottles)`,
            `bt-${store.num}-${product.code}`,
          )
        } else {
          const byProduct = {}
          for (const h of hits) {
            byProduct[h.product.name] = (byProduct[h.product.name] || 0) + 1
          }
          const summary = Object.entries(byProduct)
            .map(([n, c]) => `${n} at ${c} store${c > 1 ? 's' : ''}`)
            .join(', ')
          sendNotif(
            `🥃 ${hits.length} new in-stock alerts`,
            summary,
            `bt-multi-${Date.now()}`,
          )
        }
      }

      prevInventoryRef.current = next
      setInventory(next)
      setLastChecked(new Date())
    } catch (e) {
      setError(e.message || 'Request failed')
    } finally {
      setLoading(false)
      inFlightRef.current = false
    }
  }, [activeCodes, anchorNums, notifStatus, sendNotif, activeProductsRef, notifyEnabledRef])

  // --- Initial fetch ------------------------------------------------------
  // Runs once on mount and any time the set of tracked products changes.
  useEffect(() => { refresh() }, [refresh])

  // --- Auto-refresh loop --------------------------------------------------
  const intervalMs = INTERVALS.find(i => i.key === intervalKey)?.ms ?? 0
  useEffect(() => {
    if (!intervalMs) return undefined
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, refresh])

  // --- Tick "now" every 30s so countdown label stays fresh ----------------
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [])

  // --- Leaflet needs to recalc its size after the pane is re-shown on mobile
  useEffect(() => {
    if (mobileView !== 'map') return undefined
    const id = setTimeout(() => mapRef.current?.invalidateSize(), 60)
    return () => clearTimeout(id)
  }, [mobileView])

  // --- Geolocation ---------------------------------------------------------
  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocStatus('unavailable')
      setError('Geolocation is not available in this browser.')
      return
    }
    setLocStatus('requesting')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lon: pos.coords.longitude }
        setUserLoc(next)
        setLocStatus('granted')
        // Pan the map to the user so they see the closest stores at a glance.
        if (mapRef.current) mapRef.current.setView([next.lat, next.lon], 9)
      },
      (err) => {
        if (err.code === 1) {
          setLocStatus('denied')
          setError('Location permission was denied. Enable it in your browser settings to sort by distance.')
        } else {
          setLocStatus('unavailable')
          setError('Could not get your location. Try again in a moment.')
        }
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 },
    )
  }, [])

  const clearLocation = useCallback(() => {
    setUserLoc(null)
    setLocStatus('idle')
  }, [])

  // --- Notification toggle handler ----------------------------------------
  const handleNotifyToggle = async () => {
    if (!notifyEnabled) {
      // user is turning it ON
      if (notifStatus === 'unsupported') {
        setError("This browser doesn't support notifications.")
        return
      }
      if (notifStatus !== 'granted') {
        const result = await requestNotif()
        if (result !== 'granted') {
          setError('Notification permission was denied. Enable it in your browser settings to receive alerts.')
          return
        }
      }
      setNotifyEnabled(true)
      sendNotif('Bourbon Scout ready', 'You\'ll get a ping when new stock shows up.', 'bt-welcome')
    } else {
      setNotifyEnabled(false)
    }
  }

  // The set of stores the UI cares about right now. Without a user
  // location it's the user's favorites (falling back to the curated
  // short-list if they haven't picked any yet). With a location it's
  // the 5 stores closest to the user, drawn from everything we know.
  const displayStores = useMemo(() => {
    if (!userLoc) {
      return favoriteStores.length > 0 ? favoriteStores : STORES
    }
    const NEAREST_N = 5
    const candidates = [...knownStores.values()].filter(
      s => s.lat != null && s.lon != null
    )
    const pool = candidates.length > 0 ? candidates : STORES
    return [...pool]
      .map(s => ({ s, d: distanceMiles(userLoc.lat, userLoc.lon, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAREST_N)
      .map(x => x.s)
  }, [userLoc, favoriteStores, knownStores])

  // --- Derived stats ------------------------------------------------------
  const totalBottles = useMemo(() => {
    let sum = 0
    for (const s of displayStores) {
      const inv = inventory[s.num.replace(/^0+/, '')] || {}
      for (const p of activeProducts) {
        const n = Number(inv[p.code])
        if (Number.isFinite(n) && n > 0) sum += n
      }
    }
    return sum
  }, [displayStores, inventory, activeProducts])

  const storesWithStock = useMemo(() => {
    return displayStores.filter(s => {
      const inv = inventory[s.num.replace(/^0+/, '')] || {}
      return activeProducts.some(p => Number(inv[p.code]) > 0)
    }).length
  }, [displayStores, inventory, activeProducts])

  // Decorate stores with their bottle total and (if we have a user
  // location) distance. Default sort: most bottles first. With a user
  // location: in-stock stores first, ordered by distance ascending —
  // out-of-stock stores fall to the bottom, also by distance.
  const sortedStores = useMemo(() => {
    const decorated = displayStores.map(s => {
      const inv = inventory[s.num.replace(/^0+/, '')] || {}
      let total = 0
      for (const p of activeProducts) {
        const n = Number(inv[p.code])
        if (Number.isFinite(n) && n > 0) total += n
      }
      const distance = userLoc
        ? distanceMiles(userLoc.lat, userLoc.lon, s.lat, s.lon)
        : null
      return { store: s, total, distance }
    })
    if (userLoc) {
      decorated.sort((a, b) => {
        const aHas = a.total > 0 ? 0 : 1
        const bHas = b.total > 0 ? 0 : 1
        if (aHas !== bHas) return aHas - bHas
        return a.distance - b.distance
      })
    } else {
      decorated.sort((a, b) => b.total - a.total)
    }
    return decorated
  }, [displayStores, inventory, activeProducts, userLoc])

  // Countdown to next auto-refresh
  const nextCheckLabel = useMemo(() => {
    if (!intervalMs || !lastChecked) return null
    const elapsed = now - lastChecked.getTime()
    const remaining = intervalMs - elapsed
    if (remaining <= 0) return 'checking…'
    return `next in ${formatCountdown(remaining)}`
  }, [intervalMs, lastChecked, now])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">※</span>
          <span className="brand__name">Bourbon Scout</span>
          <span className="brand__sub">VA ABC field inventory</span>
        </div>
        <div className="topbar__meta">
          <div className="stat">
            <div className="stat__num">{totalBottles}</div>
            <div className="stat__label">bottles tracked</div>
          </div>
          <div className="stat">
            <div className="stat__num">{storesWithStock}<span className="stat__over">/{STORES.length}</span></div>
            <div className="stat__label">stores w/ stock</div>
          </div>
          <button
            type="button"
            className={`nearme ${userLoc ? 'nearme--on' : ''}`}
            onClick={userLoc ? clearLocation : requestLocation}
            disabled={locStatus === 'requesting'}
            title={
              userLoc ? 'Sorted by distance from your location — click to clear'
              : locStatus === 'denied' ? 'Location blocked — enable it in browser settings'
              : 'Sort the list by distance from your current location'
            }
          >
            {locStatus === 'requesting' ? 'locating…'
              : userLoc ? '✓ near me'
              : 'near me'}
          </button>
          <button
            type="button"
            className="refresh"
            onClick={refresh}
            disabled={loading || activeCodes.size === 0}
          >
            {loading ? 'scouting…' : 'refresh'}
          </button>
        </div>
      </header>

      <ProductPicker
        products={PRODUCTS}
        activeCodes={activeCodes}
        onToggle={toggleCode}
      />

      <div className="controls">
        <div className="controls__group">
          <span className="controls__label">CHECK</span>
          <div className="seg">
            {INTERVALS.map(opt => (
              <button
                key={opt.key}
                type="button"
                className={`seg__btn ${intervalKey === opt.key ? 'seg__btn--on' : ''}`}
                onClick={() => setIntervalKey(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="controls__group">
          <span className="controls__label">ALERTS</span>
          <button
            type="button"
            className={`toggle ${notifyEnabled && notifStatus === 'granted' ? 'toggle--on' : ''}`}
            onClick={handleNotifyToggle}
            title={
              notifStatus === 'unsupported' ? 'Browser does not support notifications' :
              notifStatus === 'denied' ? 'Notifications blocked — enable in browser settings' :
              notifyEnabled ? 'Notifications on — click to disable' : 'Click to enable notifications'
            }
          >
            <span className="toggle__dot" />
            {notifStatus === 'unsupported' ? 'unsupported' :
             notifStatus === 'denied'      ? 'blocked' :
             notifyEnabled                  ? 'on' : 'off'}
          </button>
        </div>

        {nextCheckLabel && (
          <div className="controls__status">{nextCheckLabel}</div>
        )}
      </div>

      {error && (
        <div className="error">
          {error}
          <button type="button" className="error__close" onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="viewtabs" role="tablist" aria-label="View">
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === 'list'}
          className={`viewtabs__btn ${mobileView === 'list' ? 'viewtabs__btn--on' : ''}`}
          onClick={() => setMobileView('list')}
        >
          List
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === 'map'}
          className={`viewtabs__btn ${mobileView === 'map' ? 'viewtabs__btn--on' : ''}`}
          onClick={() => setMobileView('map')}
        >
          Map
        </button>
      </div>

      <div className="body" data-view={mobileView}>
        <aside className="list">
          {sortedStores.length === 0 && (
            <div className="empty">
              No favorites yet — turn on <strong>Near me</strong> and tap the ★
              on a store to keep tabs on it.
            </div>
          )}
          {sortedStores.map(({ store, distance }) => (
            <StoreRow
              key={store.num}
              store={store}
              inventory={inventory}
              activeProducts={activeProducts}
              distance={distance}
              isFavorite={favoriteNums.has(store.num)}
              selected={selectedStore === store.num}
              onSelect={() => setSelectedStore(store.num === selectedStore ? null : store.num)}
              onToggleFavorite={() => toggleFavorite(store.num)}
            />
          ))}
        </aside>

        <section className="map">
          <MapContainer
            center={[38.25, -78.1]}
            zoom={8}
            zoomControl={false}
            ref={mapRef}
            style={{ height: '100%', width: '100%' }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
            <ZoomControl position="bottomright" />
            {userLoc && (
              <CircleMarker
                center={[userLoc.lat, userLoc.lon]}
                radius={7}
                pathOptions={{
                  color: '#60a5fa',
                  fillColor: '#60a5fa',
                  fillOpacity: 0.95,
                  weight: 2,
                }}
              >
                <Popup>You are here</Popup>
              </CircleMarker>
            )}
            {displayStores.map(s => {
              const inv = inventory[s.num.replace(/^0+/, '')] || {}
              const best = activeProducts.reduce((max, p) => {
                const n = Number(inv[p.code])
                return Number.isFinite(n) && n > max ? n : max
              }, -1)
              const color = stockColor(best < 0 ? null : best)
              const radius = selectedStore === s.num ? 14 : (best > 0 ? 10 : 7)
              return (
                <CircleMarker
                  key={s.num}
                  center={[s.lat, s.lon]}
                  radius={radius}
                  pathOptions={{
                    color: color,
                    fillColor: color,
                    fillOpacity: 0.75,
                    weight: selectedStore === s.num ? 3 : 1.5,
                  }}
                  eventHandlers={{
                    click: () => setSelectedStore(s.num),
                  }}
                >
                  <Popup>
                    <div className="pop">
                      <div className="pop__title">#{s.num} — {s.label}</div>
                      <div className="pop__addr">{s.address}</div>
                      <ul className="pop__list">
                        {activeProducts.map(p => (
                          <li key={p.code}>
                            <span>{p.name}</span>
                            <strong>{stockLabel(inv[p.code])}</strong>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Popup>
                </CircleMarker>
              )
            })}
          </MapContainer>
        </section>
      </div>

      <footer className="foot">
        <span>
          {lastChecked
            ? `last scouted ${lastChecked.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : 'awaiting first scout'}
        </span>
        <span className="foot__legend">
          <i style={{ background: '#a3e635' }} /> plenty
          <i style={{ background: '#facc15' }} /> some
          <i style={{ background: '#f59e0b' }} /> low
          <i style={{ background: '#6b2424' }} /> out
          <i style={{ background: '#8a7a62' }} /> unknown
        </span>
      </footer>
    </div>
  )
}
