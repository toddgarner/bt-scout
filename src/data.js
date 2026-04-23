// VA ABC stores we're scouting. Lat/lon are approximate — adjust if you care about precision.
// Add/remove rows freely; nothing else in the app is hardcoded to this list.
export const STORES = [
  { num: '130', label: 'Colonial Beach', address: '700 McKinney Blvd', lat: 38.2515, lon: -76.9610 },
  { num: '140', label: 'Lexington', address: '445 E Nelson St', lat: 37.7836, lon: -79.4415 },
  { num: '183', label: 'Fredericksburg', address: '9 Village Center Dr', lat: 38.3370, lon: -77.5110 },
  { num: '200', label: 'Stafford', address: '356 Garrisonville Rd', lat: 38.4888, lon: -77.4128 },
  { num: '264', label: 'Woodbridge', address: '16661 River Ridge Blvd', lat: 38.5990, lon: -77.3100 },
  { num: '316', label: 'Dumfries', address: '4108 Fortuna Center Plaza', lat: 38.5700, lon: -77.3360 },
  { num: '338', label: 'Charlottesville', address: '125 Lucy Lane', lat: 38.0293, lon: -78.4767 },
  { num: '386', label: 'Stuarts Draft', address: '2576 Stuarts Draft Hwy', lat: 38.0300, lon: -79.0244 },
  { num: '406', label: 'Stafford Publix', address: '1630 Publix Way', lat: 37.7600, lon: -79.4500 },
  { num: '412', label: 'North Stafford', address: '50 N Stafford Complex Ctr', lat: 38.4840, lon: -77.4280 },
  { num: '440', label: 'Waynesboro', address: '219 Arch Ave', lat: 38.0685, lon: -78.8895 },
  { num: '122', label: 'Staunton', address: '201 State Street', lat: 38.1496, lon: -79.0722 },
]

// Products you can toggle on in the UI. Add more codes here to extend.
// Codes come from the VA ABC product catalog (the 6-digit NC code).
export const PRODUCTS = [
  { code: '018006', name: 'Buffalo Trace 750ml', defaultOn: true },
  { code: '016850', name: 'Blanton\'s Single Barrel 750ml', defaultOn: true },
  { code: '017766', name: 'Eagle Rare 10yr 750ml', defaultOn: false },
  { code: '016483', name: 'Old Fitzgerald BiB', defaultOn: false },
  { code: '021602', name: 'E.H. Taylor Small Batch', defaultOn: false },
  { code: '027101', name: 'E.H. Taylor Straight Rye', defaultOn: false },
  { code: '025091', name: 'E.H. Taylor Barrel Proof', defaultOn: false },
  { code: '021106', name: 'Pure Kentucky XO', defaultOn: false },
  { code: '020384', name: 'Old Forester 1924 Craft Bourbon 750ml', defaultOn: false },
]
