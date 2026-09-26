// Web Mercator, the projection every slippy map tile uses. World coordinates
// run 0..1 on both axes (x east from the antimeridian, y south from the top
// of the map); at zoom z the world is 256 * 2^z pixels wide.

export type View = {
  /** Map centre in world coordinates. */
  x: number
  y: number
  /** Zoom level; fractional between the integer tile levels. */
  z: number
}

export const TILE = 256
export const MIN_ZOOM = 1
export const MAX_ZOOM = 20

export function mercator(lat: number, lon: number): [number, number] {
  let clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
  let s = Math.sin((clamped * Math.PI) / 180)
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
}

export function clampView(v: View): View {
  let z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z))
  let x = v.x - Math.floor(v.x)
  let y = Math.max(0, Math.min(1, v.y))
  return { x, y, z }
}

/** Moves the view by a screen-pixel drag. */
export function panBy(v: View, dx: number, dy: number): View {
  let scale = TILE * 2 ** v.z
  return clampView({ x: v.x - dx / scale, y: v.y - dy / scale, z: v.z })
}

/**
 * Zooms by `factor` keeping the world point under screen point (fx, fy)
 * where it is; (w, h) is the map's size on screen.
 */
export function zoomAbout(v: View, factor: number, fx: number, fy: number, w: number, h: number): View {
  let scale = TILE * 2 ** v.z
  let wx = v.x + (fx - w / 2) / scale
  let wy = v.y + (fy - h / 2) / scale
  let z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z + Math.log2(factor)))
  let next = TILE * 2 ** z
  return clampView({ x: wx - (fx - w / 2) / next, y: wy - (fy - h / 2) / next, z })
}

/** The view showing world box [x0, y0, x1, y1] in a w x h map, with some margin. */
export function fitBounds(b: [number, number, number, number], w: number, h: number, maxZoom = 16): View {
  let [x0, y0, x1, y1] = b
  let bw = Math.max(x1 - x0, 1e-7)
  let bh = Math.max(y1 - y0, 1e-7)
  let z = Math.log2(Math.min((w * 0.8) / (bw * TILE), (h * 0.8) / (bh * TILE)))
  return clampView({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: Math.min(maxZoom, z) })
}
