"use isolate"
// Photo pixels, off the UI thread: grid thumbnails and the full-size view.
//
// A thumbnail is the small JPEG most cameras embed in the EXIF block when
// there is one (a few KB to read), else the photo itself decoded and
// shrunk. Either way it is turned upright from the EXIF orientation, and
// saved to thumbs/ in the app's private storage so the next time costs one
// small read. Formats flux cannot decode (HEIC, raw) without an embedded
// JPEG thumbnail come back as null and show as a placeholder.
import { decodeImage, encodeImage, type DecodedImage } from "flux:image"
import { dir, file } from "flux:fs"
import { readJpegExtras } from "./exif"

export type Pixels = { data: Uint8Array; width: number; height: number }

const THUMB = 256

function reader(path: string, size: number) {
  let f = file(path)
  return (offset: number, length: number) => f.read(offset, Math.max(0, Math.min(length, size - offset)))
}

function decodable(path: string) {
  return /\.(jpe?g|png|webp)$/i.test(path)
}

export async function thumb(path: string, key: string): Promise<Pixels | null> {
  let cached = file(`thumbs/${key}.jpg`)
  try {
    if (await cached.exists()) return decodeImage(await cached.bytes())
  } catch {}
  let size = (await file(path).stat()).size
  let { orientation, thumb: embedded } = await readJpegExtras(reader(path, size), size)
  let img: DecodedImage | null = null
  if (embedded) {
    try {
      img = decodeImage(embedded)
    } catch {}
  }
  if (!img) {
    if (!decodable(path)) return null
    try {
      img = decodeImage(await file(path).bytes())
    } catch {
      return null
    }
  }
  img = orient(shrink(img, THUMB, 3), orientation)
  try {
    await dir("thumbs").create()
    await cached.write(encodeImage(img, { format: "jpeg", quality: 0.85 }))
  } catch {}
  return img
}

/** The photo upright and at most `max` pixels on its long side, or null when it cannot be decoded. */
export async function full(path: string, max: number): Promise<Pixels | null> {
  if (!decodable(path)) return null
  let bytes = await file(path).bytes()
  let { orientation } = await readJpegExtras(async (o, n) => bytes.subarray(o, o + n), bytes.length)
  let img: DecodedImage
  try {
    img = decodeImage(bytes)
  } catch {
    return null
  }
  return orient(shrink(img, max, 1), orientation)
}

// Box-ish downscale: each output pixel averages `samples` x `samples` points
// spread over its source block (1 = nearest, the fast path for big images).
function shrink(img: DecodedImage, max: number, samples: number): DecodedImage {
  let { width: w, height: h, data } = img
  let k = Math.max(w, h) / max
  if (k <= 1) return img
  let ow = Math.max(1, Math.round(w / k))
  let oh = Math.max(1, Math.round(h / k))
  let out = new Uint8Array(ow * oh * 4)
  let s = Math.min(samples, Math.ceil(k))
  let n = s * s
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < s; sy++) {
        let py = Math.min(h - 1, Math.floor((y + (sy + 0.5) / s) * k))
        for (let sx = 0; sx < s; sx++) {
          let px = Math.min(w - 1, Math.floor((x + (sx + 0.5) / s) * k))
          let i = (py * w + px) * 4
          r += data[i]!
          g += data[i + 1]!
          b += data[i + 2]!
          a += data[i + 3]!
        }
      }
      let o = (y * ow + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = a / n
    }
  }
  return { data: out, width: ow, height: oh }
}

// EXIF orientations 3 (180), 6 (90 clockwise) and 8 (90 counter-clockwise);
// the mirrored ones are rare enough to show as stored.
function orient(img: DecodedImage, orientation: number): DecodedImage {
  if (orientation !== 3 && orientation !== 6 && orientation !== 8) return img
  let { width: w, height: h, data } = img
  let turn = orientation !== 3
  let ow = turn ? h : w
  let oh = turn ? w : h
  let out = new Uint8Array(data.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = orientation === 3 ? w - 1 - x : orientation === 6 ? h - 1 - y : y
      let ny = orientation === 3 ? h - 1 - y : orientation === 6 ? x : w - 1 - x
      let i = (y * w + x) * 4
      let o = (ny * ow + nx) * 4
      out[o] = data[i]!
      out[o + 1] = data[i + 1]!
      out[o + 2] = data[i + 2]!
      out[o + 3] = data[i + 3]!
    }
  }
  return { data: out, width: ow, height: oh }
}
