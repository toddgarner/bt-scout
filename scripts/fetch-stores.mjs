#!/usr/bin/env node
// Crawl VA ABC's storeNearby endpoint and write the full store directory
// to src/stores.all.json.
//
// How it works: seed with the curated short-list from src/data.js, hit
// storeNearby for each anchor, harvest every store the response mentions
// (storeInfo + nearbyStores), and queue any newly-seen stores as anchors
// for the next round. Continue until the queue drains.
//
// Usage:
//   node scripts/fetch-stores.mjs
//
// Requires Node 18+ (uses global fetch).

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_PATH = path.join(__dirname, '..', 'src', 'stores.all.json')
const DATA_PATH = path.join(__dirname, '..', 'src', 'data.js')

const ENDPOINT = 'https://www.abc.virginia.gov/webapi/inventory/storeNearby'

// VA ABC's API is gated on browser-like headers (the same Origin/Referer
// the dev-server proxy sets — see vite.config.js).
const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Referer': 'https://www.abc.virginia.gov/',
  'Origin':  'https://www.abc.virginia.gov',
}

// Buffalo Trace 750ml — a stable, always-present catalog item. The
// product itself is irrelevant; we only care about the store records
// riding along in the response.
const PROBE_PRODUCT = '018006'

// Politeness: rough cap so a misbehaving response can't hammer the API.
const REQUEST_GAP_MS = 150
const MAX_CALLS = 1000

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function loadSeeds() {
  const text = await fs.readFile(DATA_PATH, 'utf8')
  const m = text.match(/export const STORES = \[([\s\S]*?)\]/)
  if (!m) throw new Error('Could not parse STORES from src/data.js')
  const nums = [...m[1].matchAll(/num:\s*'(\d+)'/g)].map(x => x[1])
  if (nums.length === 0) throw new Error('No store numbers found in src/data.js')
  return [...new Set(nums)]
}

async function fetchNearby(storeNumber, attempt = 1) {
  const params = new URLSearchParams({
    storeNumber,
    productCode: PROBE_PRODUCT,
    mileRadius: '999',
    storeCount: '5',
    buffer: '0',
  })
  const res = await fetch(`${ENDPOINT}?${params}`, { headers: HEADERS })
  if (res.status === 429 || res.status === 503) {
    if (attempt > 4) throw new Error(`HTTP ${res.status} after ${attempt} attempts`)
    const retryAfter = Number(res.headers.get('Retry-After')) || (2 ** attempt)
    process.stdout.write(`  rate-limited, waiting ${retryAfter}s `)
    await sleep(retryAfter * 1000)
    return fetchNearby(storeNumber, attempt + 1)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k]
    if (v != null && v !== '') return v
  }
  return undefined
}

function metaFromInfo(info) {
  const num = String(info?.storeId ?? '').replace(/^0+/, '') || null
  if (!num) return null
  const lat = Number(pick(info, 'latitude', 'lat', 'storeLatitude'))
  const lon = Number(pick(info, 'longitude', 'lng', 'lon', 'storeLongitude'))
  return {
    num,
    label:   pick(info, 'storeName', 'name', 'displayName') || `Store #${num}`,
    address: pick(info, 'address1', 'streetAddress', 'address') || '',
    city:    pick(info, 'city', 'storeCity') || '',
    lat: Number.isFinite(lat) ? Number(lat.toFixed(4)) : null,
    lon: Number.isFinite(lon) ? Number(lon.toFixed(4)) : null,
  }
}

async function main() {
  const seeds = await loadSeeds()
  console.log(`Seeded with ${seeds.length} stores from src/data.js`)

  const known = new Map()           // num -> meta
  const queue = [...seeds]
  const visited = new Set()
  let calls = 0

  while (queue.length && calls < MAX_CALLS) {
    const num = queue.shift()
    if (visited.has(num)) continue
    visited.add(num)
    process.stdout.write(`#${num.padStart(4)}  `)

    let data
    try {
      data = await fetchNearby(num)
      calls++
    } catch (err) {
      process.stdout.write(`err: ${err.message}\n`)
      continue
    }

    const products = Array.isArray(data?.products) ? data.products : []
    let newCount = 0
    for (const prod of products) {
      const entries = [prod.storeInfo, ...(prod.nearbyStores ?? [])]
      for (const info of entries) {
        const meta = metaFromInfo(info)
        if (!meta) continue
        if (!known.has(meta.num)) {
          known.set(meta.num, meta)
          newCount++
          if (!visited.has(meta.num)) queue.push(meta.num)
        }
      }
    }
    process.stdout.write(`+${newCount} new (total ${known.size}, queued ${queue.length})\n`)

    if (calls === 1) {
      // Show the field shape on the first response so it's obvious if
      // an unexpected key needs adding to metaFromInfo.
      const sample = data?.products?.[0]?.storeInfo ?? data?.products?.[0]?.nearbyStores?.[0]
      if (sample) {
        console.log('  sample raw fields:', Object.keys(sample).join(', '))
      }
    }

    await sleep(REQUEST_GAP_MS)
  }

  if (calls >= MAX_CALLS) {
    console.warn(`\nReached MAX_CALLS=${MAX_CALLS}; stopped early. ` +
                 `Bump the cap in fetch-stores.mjs if you need a deeper crawl.`)
  }

  const stores = [...known.values()].sort((a, b) => Number(a.num) - Number(b.num))
  await fs.writeFile(OUT_PATH, JSON.stringify(stores, null, 2) + '\n', 'utf8')

  console.log(`\nMade ${calls} API calls, discovered ${stores.length} stores`)
  console.log(`Wrote ${path.relative(process.cwd(), OUT_PATH)}`)

  const noCoords = stores.filter(s => s.lat == null || s.lon == null).length
  if (noCoords) {
    console.log(`Note: ${noCoords} store(s) had no coordinates in the response`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
