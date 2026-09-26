"use isolate"
// Heatmap tiles, computed off the UI thread. The isolate keeps every photo
// position in Web Mercator world coordinates (0..1 on both axes), sorted by x,
// and renders one small RGBA tile per map tile on request: photos are counted
// into a grid (with a margin so blobs continue across tile edges), the grid
// is blurred with a gaussian, and the density is coloured on a log scale so
// a street with five photos and a home town with five thousand both read.
import { Database } from "flux:sqlite"
import { mercator } from "./geo"

/** Heat tile resolution: a 256 px map tile gets a 64x64 heat tile (4 px per cell). */
export const HEAT_SIZE = 64
const R = 12
const SIGMA = 2.6
const D = HEAT_SIZE + 2 * R

let xs = new Float64Array(0)
let ys = new Float64Array(0)

// A gaussian shifted down to reach exactly zero at the radius, so a pile of
// photos fades out instead of ending at a hard ring where the kernel stops.
const EDGE = Math.exp(-(R * R) / (2 * SIGMA * SIGMA))
const KERNEL = Array.from({ length: 2 * R + 1 }, (_, i) => (Math.exp(-((i - R) ** 2) / (2 * SIGMA * SIGMA)) - EDGE) / (1 - EDGE))

/** Re-reads every located photo from photos.db. Resolves to how many there are. */
export async function load(): Promise<number> {
  let db = await Database.open("photos.db", "ro")
  let rows = await db.query("SELECT lat, lon FROM photos WHERE lat IS NOT NULL AND lon IS NOT NULL").all()
  await db.close()
  let pts = rows.map((r) => mercator(r.lat as number, r.lon as number))
  pts.sort((a, b) => a[0] - b[0])
  xs = new Float64Array(pts.length)
  ys = new Float64Array(pts.length)
  for (let i = 0; i < pts.length; i++) {
    xs[i] = pts[i]![0]
    ys[i] = pts[i]![1]
  }
  return pts.length
}

/**
 * The region most photos are in, as world [x0, y0, x1, y1]: the 2nd to 98th
 * percentile on each axis, so one holiday abroad does not zoom the first view
 * out to the whole planet. null with no photos.
 */
export function bounds(): [number, number, number, number] | null {
  let n = xs.length
  if (!n) return null
  let sortedY = Float64Array.from(ys).sort()
  let lo = Math.floor(n * 0.02)
  let hi = Math.min(n - 1, Math.ceil(n * 0.98) - 1)
  return [xs[lo]!, sortedY[lo]!, xs[Math.max(lo, hi)]!, sortedY[Math.max(lo, hi)]!]
}

// First index with xs[i] >= v.
function lowerBound(v: number): number {
  let lo = 0
  let hi = xs.length
  while (lo < hi) {
    let mid = (lo + hi) >> 1
    if (xs[mid]! < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The heat tile for map tile (z, x, y): HEAT_SIZE x HEAT_SIZE premultiplied
 * RGBA, or null where no photo is near.
 */
export function tile(z: number, tx: number, ty: number): Uint8Array | null {
  let n = 2 ** z
  let cell = 1 / (n * HEAT_SIZE)
  let ox = tx / n - R * cell
  let oy = ty / n - R * cell
  let span = D * cell
  let grid = new Float32Array(D * D)
  let any = false
  // The tile's x range may cross the antimeridian: look at the copies of the
  // world on either side too.
  for (let shift = -1; shift <= 1; shift++) {
    let a = ox - shift
    let b = a + span
    if (b <= 0 || a >= 1) continue
    for (let i = lowerBound(a); i < xs.length && xs[i]! < b; i++) {
      let cy = Math.floor((ys[i]! - oy) / cell)
      if (cy < 0 || cy >= D) continue
      let cx = Math.floor((xs[i]! - a) / cell)
      if (cx < 0 || cx >= D) continue
      grid[cy * D + cx]! += 1
      any = true
    }
  }
  if (!any) return null

  // Separable gaussian: rows into tmp (only the tile's own columns are
  // needed), then columns into the output cells.
  let tmp = new Float32Array(D * HEAT_SIZE)
  for (let y = 0; y < D; y++) {
    let row = y * D
    for (let x = 0; x < HEAT_SIZE; x++) {
      let sum = 0
      for (let k = 0; k <= 2 * R; k++) sum += grid[row + x + k]! * KERNEL[k]!
      tmp[y * HEAT_SIZE + x] = sum
    }
  }
  let out = new Uint8Array(HEAT_SIZE * HEAT_SIZE * 4)
  let lit = false
  for (let y = 0; y < HEAT_SIZE; y++) {
    for (let x = 0; x < HEAT_SIZE; x++) {
      let d = 0
      for (let k = 0; k <= 2 * R; k++) d += tmp[(y + k) * HEAT_SIZE + x]! * KERNEL[k]!
      if (d < 0.02) continue
      lit = true
      colorize(d, out, (y * HEAT_SIZE + x) * 4)
    }
  }
  return lit ? out : null
}

// Blue -> cyan -> green -> yellow -> red over log2(1 + density) / 9, so the
// ramp tops out around 500 photos under one blob.
const STOPS: [number, number, number, number][] = [
  [0, 40, 110, 255],
  [0.25, 0, 205, 255],
  [0.5, 110, 235, 70],
  [0.75, 255, 190, 0],
  [1, 255, 45, 45],
]

function colorize(d: number, out: Uint8Array, at: number) {
  let t = Math.min(1, Math.log2(1 + d) / 9)
  let i = 1
  while (i < STOPS.length - 1 && STOPS[i]![0] < t) i++
  let [t0, r0, g0, b0] = STOPS[i - 1]!
  let [t1, r1, g1, b1] = STOPS[i]!
  let f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)))
  // Opacity ramps in linearly with the density (colour is on the log scale),
  // so even a big pile of photos fades out over a few cells at its rim.
  let e = Math.min(1, (d - 0.02) / 1.5)
  let alpha = e * e * (3 - 2 * e) * (0.6 + 0.35 * t)
  out[at] = (r0 + (r1 - r0) * f) * alpha
  out[at + 1] = (g0 + (g1 - g0) * f) * alpha
  out[at + 2] = (b0 + (b1 - b0) * f) * alpha
  out[at + 3] = alpha * 255
}
