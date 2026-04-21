# Bourbon Scout

Track Buffalo Trace (and other hard-to-find bourbons) across Virginia ABC
stores. Hits the public `/webapi/inventory/mystore` endpoint, pins stores on
a dark map with stock-level coloring.

## Quick start

```bash
npm install
npm run dev
```

Opens on http://localhost:5173. The Vite dev server proxies
`/api/inventory/*` to `abc.virginia.gov` so CORS isn't an issue locally.

## Deploy

### Vercel (recommended for this setup)

```bash
vercel
```

The `vercel.json` rewrites `/api/inventory/*` to the real ABC endpoint, so the
static site calls what looks like same-origin API routes. No serverless
functions required.

### Netlify

```bash
netlify deploy --prod
```

`netlify.toml` handles the equivalent redirect.

### Anywhere else

If your host doesn't support URL rewrites, you'll need a tiny serverless
function (~20 lines) that forwards the request. The easiest migration is to
move to Vercel or Netlify.

## Notifications & polling

- **Interval picker** (top bar): `Manual`, `2h`, `4h`, `8h`. Defaults to 4h.
  When set to an interval, the app calls the API in the background and updates
  the map. "Manual" means it only refreshes when you click the button.
- **Alerts toggle**: asks for browser notification permission on first enable.
  When on, you'll get a system notification whenever a tracked product
  transitions from `0` to `>0` at any store — i.e. actual *new* stock, not
  just repeat confirmations.
- Both the interval choice and alerts toggle persist in `localStorage`.

The transition logic deliberately requires a *known previous value of 0* to
fire — so you won't get spammed on the first load when every cell is coming
up for the first time. If you want to broaden that (e.g. fire on any
unknown-to-in-stock transition), edit `findNewlyInStock()` in `App.jsx`.

## Configuring stores and products

Both live in `src/data.js`:

- **STORES** — array of `{ num, label, address, lat, lon }`. Add or remove
  freely; the UI re-renders from this list.
- **PRODUCTS** — array of `{ code, name, defaultOn }`. The 6-digit `code` is
  the VA ABC product catalog number (visible in URLs like
  `/products/018006`). `defaultOn: true` means the chip is pre-selected on
  load.

## Notes on the API

The endpoint isn't formally documented. Response shape is inferred:

```
GET /webapi/inventory/mystore?storeNumbers=200,412&productCodes=018006

[
  { "storeNumber": "200", "productCode": "018006", "quantity": 4 },
  ...
]
```

`src/App.jsx` `indexInventory()` handles a few likely field-name variants
(`storeNumber` vs `StoreNumber`, `quantity` vs `Quantity` vs `inventory`).
If the map shows all unknowns after a successful refresh, open DevTools,
look at the raw response, and adjust that function.

## Stock color ramp

| Qty | Color |
|---|---|
| unknown | stone |
| 0 | near-black |
| 1-2 | amber |
| 3-9 | gold |
| 10+ | lime |
