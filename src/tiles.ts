// Map tiles: the background map, fetched from a tile server and kept on disk.
//
// Default source: OpenStreetMap's own tile server (tile.openstreetmap.org),
// run by the non-profit OpenStreetMap Foundation - no account, no API key, no
// ads or tracking, and its privacy policy keeps request logs only briefly.
// A tile request still tells the server which area is on screen, so every
// tile is written to the app's private storage the first time it is fetched
// and read from there afterwards; tiles can also be switched off entirely in
// Folders & settings, and the map then shows only the heatmap on a grid.
//
// Textures live in a reference-counted cache: a tile on screen holds a
// reference, and textures nobody holds are freed once the cache grows past
// its budget.
import { createTexture } from "@solidrt/core/gpu"
import type { TextureId } from "@solidrt/core/gpu"
import { destroyTexture } from "@solidrt/core/gpu"
import { decodeImage } from "flux:image"
import { dir, file } from "flux:fs"

export type TileSource = {
  id: string
  name: string
  url: (z: number, x: number, y: number) => string
  attribution: string
  maxZoom: number
}

export const OSM: TileSource = {
  id: "osm",
  name: "OpenStreetMap",
  url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  attribution: "© OpenStreetMap contributors",
  maxZoom: 19,
}

// The tile usage policy asks for an identifying User-Agent.
const USER_AGENT = "solidPhotoMap/0.1 (personal photo map; SolidRT)"
const CONCURRENT = 4

type Entry = { tex: TextureId | null; refs: number; used: number; promise: Promise<TextureId | null> }

/** A reference-counted texture cache keyed by string. */
export class TextureCache {
  private entries = new Map<string, Entry>()
  private clock = 0
  constructor(
    private budget: number,
    private load: (key: string) => Promise<TextureId | null>,
  ) {}

  /** Takes a reference on `key`, loading it if needed; release it when done. */
  acquire(key: string): Promise<TextureId | null> {
    let e = this.entries.get(key)
    if (!e) {
      e = { tex: null, refs: 0, used: 0, promise: null! }
      let entry = e
      e.promise = this.load(key).then(
        (tex) => {
          // Dropped from the cache while loading: nobody will free it later.
          if (this.entries.get(key) !== entry) {
            if (tex != null) destroyTexture(tex)
            return null
          }
          entry.tex = tex
          return tex
        },
        () => null,
      )
      this.entries.set(key, e)
    }
    e.refs++
    e.used = ++this.clock
    return e.promise
  }

  release(key: string) {
    let e = this.entries.get(key)
    if (!e) return
    e.refs--
    this.evict()
  }

  /** Frees every texture nobody holds (the heat tiles after a re-index). */
  clearUnused() {
    for (let [key, e] of this.entries) {
      if (e.refs > 0) continue
      if (e.tex != null) destroyTexture(e.tex)
      this.entries.delete(key)
    }
  }

  private evict() {
    if (this.entries.size <= this.budget) return
    let idle = [...this.entries].filter(([, e]) => e.refs <= 0).sort((a, b) => a[1].used - b[1].used)
    for (let [key, e] of idle.slice(0, this.entries.size - this.budget)) {
      if (e.tex != null) destroyTexture(e.tex)
      this.entries.delete(key)
    }
  }
}

// Fetches run LIFO: the most recently requested tiles are the ones on screen.
let queue: (() => void)[] = []
let running = 0
function limited<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(() => {
      running++
      job()
        .then(resolve, reject)
        .finally(() => {
          running--
          queue.pop()?.()
        })
    })
    if (running < CONCURRENT) queue.pop()!()
  })
}

async function tileBytes(source: TileSource, z: number, x: number, y: number): Promise<Uint8Array | null> {
  let folder = `tiles/${source.id}/${z}/${x}`
  let cached = file(`${folder}/${y}.png`)
  try {
    if (await cached.exists()) return await cached.bytes()
  } catch {}
  return limited(async () => {
    let res = await fetch(source.url(z, x, y), { headers: { "User-Agent": USER_AGENT } })
    if (!res.ok) return null
    let bytes = await res.bytes()
    try {
      await dir(folder).create()
      await cached.write(bytes)
    } catch {}
    return bytes
  })
}

export function mapTileCache(source: TileSource): TextureCache {
  return new TextureCache(400, async (key) => {
    let [z, x, y] = key.split("/").map(Number) as [number, number, number]
    let bytes = await tileBytes(source, z, x, y)
    if (!bytes) return null
    let img = decodeImage(bytes)
    return createTexture(img.data, img.width, img.height, { autoFree: false, label: `tile ${key}` })
  })
}
