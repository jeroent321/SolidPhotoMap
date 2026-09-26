// Where and when a photo was taken, from its EXIF block. Pure TypeScript with
// no runtime imports, so it runs in the indexer isolate and under bun alike.
//
// Containers understood:
// - JPEG: the APP1 "Exif" segment before the image data.
// - HEIC / HEIF / AVIF (ISO BMFF): the "Exif" item named in the meta box's
//   iinf, located through iloc.
// - TIFF and the TIFF-based raw formats (DNG, CR2, NEF, ARW, ORF, RW2, PEF,
//   SRW): the file itself is the TIFF structure.
// Inside the TIFF structure: IFD0 points at the GPS IFD (0x8825) and the Exif
// IFD (0x8769, DateTimeOriginal lives there).

export type PhotoMeta = {
  /** Degrees, or null when the file carries no usable position. */
  lat: number | null
  lon: number | null
  /** The camera's local capture time, "YYYY-MM-DD HH:MM:SS", or null. */
  taken: string | null
}

/** Reads `length` bytes at `offset`, clamped to the end of the file. */
export type Reader = (offset: number, length: number) => Promise<Uint8Array>

export const PHOTO_EXTENSIONS = new Set([
  "jpg", "jpeg", "jpe", "heic", "heif", "hif", "avif",
  "tif", "tiff", "dng", "cr2", "nef", "nrw", "arw", "sr2", "orf", "rw2", "pef", "srw",
])

const NONE: PhotoMeta = { lat: null, lon: null, taken: null }

export async function readPhotoMeta(read: Reader, size: number): Promise<PhotoMeta> {
  let head = await read(0, Math.min(size, 64 * 1024))
  if (head.length < 12) return NONE
  // JPEG
  if (head[0] === 0xff && head[1] === 0xd8) return readJpeg(read, size, head)
  // ISO BMFF: a box whose type is "ftyp"
  if (ascii(head, 4, 4) === "ftyp") return readBmff(read, size)
  // TIFF: "II*\0" / "MM\0*", plus Panasonic's "IIU\0" and Olympus's "IIRO"/"IIRS"
  let order = ascii(head, 0, 2)
  if (order === "II" || order === "MM") {
    return parseTiffFrom(pagedReader(read, size), size)
  }
  return NONE
}

async function readJpeg(read: Reader, size: number, head: Uint8Array): Promise<PhotoMeta> {
  let buf = head
  let base = 0
  let p = 2
  // Walk the marker segments until the Exif APP1 or the start of scan.
  for (let guard = 0; guard < 64; guard++) {
    if (p + 4 > base + buf.length) {
      if (p + 4 > size) return NONE
      buf = await read(p, Math.min(size - p, 128 * 1024))
      base = p
    }
    let i = p - base
    if (buf[i] !== 0xff) return NONE
    let marker = buf[i + 1]!
    if (marker === 0xff) {
      p++
      continue
    }
    if (marker === 0xda || marker === 0xd9) return NONE
    let len = (buf[i + 2]! << 8) | buf[i + 3]!
    if (marker === 0xe1 && len > 8) {
      if (p + 2 + len > base + buf.length) {
        buf = await read(p, Math.min(size - p, len + 2))
        base = p
      }
      let s = p - base + 4
      if (ascii(buf, s, 4) === "Exif" && buf[s + 4] === 0 && buf[s + 5] === 0) {
        return parseTiff(buf.subarray(s + 6, p - base + 2 + len), 0)
      }
    }
    p += 2 + len
  }
  return NONE
}

async function readBmff(read: Reader, size: number): Promise<PhotoMeta> {
  // Find the top-level meta box.
  let p = 0
  let meta: Uint8Array | null = null
  for (let guard = 0; guard < 32 && p + 8 <= size; guard++) {
    let h = await read(p, Math.min(16, size - p))
    let len = u32be(h, 0)
    let type = ascii(h, 4, 4)
    let headerLen = 8
    if (len === 1) {
      len = u32be(h, 8) * 2 ** 32 + u32be(h, 12)
      headerLen = 16
    } else if (len === 0) len = size - p
    if (len < headerLen) return NONE
    if (type === "meta") {
      if (len > 8 * 1024 * 1024) return NONE
      meta = await read(p + headerLen, len - headerLen)
      break
    }
    p += len
  }
  if (!meta) return NONE
  // meta is a FullBox: 4 bytes of version/flags, then child boxes.
  let exifId = -1
  let locations = new Map<number, { offset: number; length: number }>()
  for (let [type, s, e] of boxes(meta, 4, meta.length)) {
    if (type === "iinf") exifId = findExifItem(meta, s, e)
    else if (type === "iloc") readIloc(meta, s, e, locations)
  }
  let loc = locations.get(exifId)
  if (!loc || loc.length < 8 || loc.length > 4 * 1024 * 1024 || loc.offset + loc.length > size) return NONE
  let item = await read(loc.offset, loc.length)
  // The item starts with a 4-byte offset to the TIFF header (after "Exif\0\0").
  let skip = 4 + u32be(item, 0)
  if (skip >= item.length) return NONE
  return parseTiff(item.subarray(skip), 0)
}

function* boxes(b: Uint8Array, start: number, end: number): Generator<[string, number, number]> {
  let p = start
  while (p + 8 <= end) {
    let len = u32be(b, p)
    let type = ascii(b, p + 4, 4)
    let header = 8
    if (len === 1) {
      len = u32be(b, p + 8) * 2 ** 32 + u32be(b, p + 12)
      header = 16
    } else if (len === 0) len = end - p
    if (len < header || p + len > end) return
    yield [type, p + header, p + len]
    p += len
  }
}

function findExifItem(b: Uint8Array, s: number, e: number): number {
  let version = b[s]!
  let count = version === 0 ? u16be(b, s + 4) : u32be(b, s + 4)
  let p = s + (version === 0 ? 6 : 8)
  for (let [type, is, ie] of boxes(b, p, e)) {
    if (type !== "infe") continue
    let v = b[is]!
    if (v < 2) continue
    let id = v === 2 ? u16be(b, is + 4) : u32be(b, is + 4)
    let typeAt = is + 4 + (v === 2 ? 2 : 4) + 2
    if (typeAt + 4 <= ie && ascii(b, typeAt, 4) === "Exif") return id
  }
  void count
  return -1
}

function readIloc(b: Uint8Array, s: number, e: number, out: Map<number, { offset: number; length: number }>) {
  let version = b[s]!
  let p = s + 4
  let offsetSize = b[p]! >> 4
  let lengthSize = b[p]! & 15
  let baseOffsetSize = b[p + 1]! >> 4
  let indexSize = version === 1 || version === 2 ? b[p + 1]! & 15 : 0
  p += 2
  let count = version < 2 ? u16be(b, p) : u32be(b, p)
  p += version < 2 ? 2 : 4
  let num = (n: number) => {
    let v = 0
    for (let i = 0; i < n; i++) v = v * 256 + b[p + i]!
    p += n
    return v
  }
  for (let i = 0; i < count && p < e; i++) {
    let id = version < 2 ? num(2) : num(4)
    let method = 0
    if (version === 1 || version === 2) method = num(2) & 15
    num(2) // data_reference_index
    let base = num(baseOffsetSize)
    let extents = num(2)
    let first: { offset: number; length: number } | null = null
    for (let x = 0; x < extents; x++) {
      if (indexSize) num(indexSize)
      let offset = num(offsetSize)
      let length = num(lengthSize)
      if (!first) first = { offset: base + offset, length }
    }
    // Only file-offset construction (method 0) with one extent is read.
    if (first && method === 0 && extents === 1) out.set(id, first)
  }
}

// --- TIFF / EXIF -----------------------------------------------------------

const TAG_EXIF_IFD = 0x8769
const TAG_GPS_IFD = 0x8825
const TAG_DATETIME = 0x0132
const TAG_DATETIME_ORIGINAL = 0x9003

export function parseTiff(b: Uint8Array, start: number): Promise<PhotoMeta> {
  let view = b.subarray(start)
  return parseTiffFrom(async (o, n) => view.subarray(o, o + n), view.length)
}

// A TIFF file keeps its IFDs anywhere (often after the image strips, at the
// end of a large file), so it is read through 64 KiB pages on demand.
function pagedReader(read: Reader, size: number): Reader {
  const PAGE = 64 * 1024
  let pages = new Map<number, Uint8Array>()
  let page = async (i: number) => {
    let p = pages.get(i)
    if (!p) {
      p = await read(i * PAGE, Math.min(PAGE, size - i * PAGE))
      pages.set(i, p)
    }
    return p
  }
  return async (o, n) => {
    n = Math.max(0, Math.min(n, size - o))
    let first = Math.floor(o / PAGE)
    let last = Math.floor((o + n - 1) / PAGE)
    if (n === 0) return new Uint8Array(0)
    if (first === last) return (await page(first)).subarray(o - first * PAGE, o - first * PAGE + n)
    let out = new Uint8Array(n)
    for (let i = first; i <= last; i++) {
      let p = await page(i)
      let from = Math.max(o, i * PAGE)
      let to = Math.min(o + n, i * PAGE + p.length)
      out.set(p.subarray(from - i * PAGE, to - i * PAGE), from - o)
    }
    return out
  }
}

async function parseTiffFrom(get: Reader, len: number): Promise<PhotoMeta> {
  let head = await get(0, 8)
  if (head.length < 8) return NONE
  let le = head[0] === 0x49
  let u16 = (b: Uint8Array, o: number) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!)
  let u32 = (b: Uint8Array, o: number) =>
    le
      ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000
      : b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!)
  let inside = (o: number, n: number) => o >= 0 && o + n <= len

  type Entry = { tag: number; type: number; count: number; at: number; inline: Uint8Array }
  let ifd = async (o: number): Promise<Entry[]> => {
    if (!inside(o, 2)) return []
    let n = u16(await get(o, 2), 0)
    if (n > 1000 || !inside(o + 2, n * 12)) return []
    let t = await get(o + 2, n * 12)
    let out: Entry[] = []
    for (let i = 0; i < n; i++) {
      let e = i * 12
      let type = u16(t, e + 2)
      let count = u32(t, e + 4)
      let unit = type === 5 || type === 10 ? 8 : type === 3 ? 2 : type === 4 || type === 9 ? 4 : 1
      let small = unit * count <= 4
      out.push({ tag: u16(t, e), type, count, at: small ? -1 : u32(t, e + 8), inline: t.subarray(e + 8, e + 12) })
    }
    return out
  }
  let value = async (e: Entry, n: number) => (e.at < 0 ? e.inline : inside(e.at, n) ? await get(e.at, n) : null)
  let text = async (e: Entry) => {
    let v = await value(e, Math.min(e.count, 64))
    return v ? ascii(v, 0, v.length).replace(/\0.*$/, "") : ""
  }
  let pointer = async (e: Entry) => u32(e.inline, 0)
  let dms = async (e: Entry) => {
    if (e.type !== 5 || e.count < 3) return NaN
    let v = await value(e, 24)
    if (!v || v.length < 24) return NaN
    let r = (o: number) => {
      let d = u32(v, o + 4)
      return d === 0 ? NaN : u32(v, o) / d
    }
    return r(0) + r(8) / 60 + r(16) / 3600
  }

  let ifd0 = await ifd(u32(head, 4))
  let taken: string | null = null
  let lat: number | null = null
  let lon: number | null = null
  let dateTime = ifd0.find((e) => e.tag === TAG_DATETIME)
  let exifPtr = ifd0.find((e) => e.tag === TAG_EXIF_IFD)
  if (exifPtr) {
    let original = (await ifd(await pointer(exifPtr))).find((e) => e.tag === TAG_DATETIME_ORIGINAL)
    if (original) taken = normalizeDate(await text(original))
  }
  if (!taken && dateTime) taken = normalizeDate(await text(dateTime))

  let gpsPtr = ifd0.find((e) => e.tag === TAG_GPS_IFD)
  if (gpsPtr) {
    let gps = await ifd(await pointer(gpsPtr))
    let find = (tag: number) => gps.find((e) => e.tag === tag)
    let latRef = find(1)
    let latV = find(2)
    let lonRef = find(3)
    let lonV = find(4)
    if (latV && lonV) {
      let la = await dms(latV)
      let lo = await dms(lonV)
      if (latRef && (await text(latRef)).startsWith("S")) la = -la
      if (lonRef && (await text(lonRef)).startsWith("W")) lo = -lo
      // 0,0 is what many cameras write when they have no fix.
      if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && (la !== 0 || lo !== 0)) {
        lat = la
        lon = lo
      }
    }
  }
  return { lat, lon, taken }
}

// "2024:07:14 18:03:22" -> "2024-07-14 18:03:22"; blanks and zeros -> null.
function normalizeDate(s: string): string | null {
  let m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim())
  if (!m || m[1] === "0000") return null
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = ""
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!)
  return s
}
function u16be(b: Uint8Array, at: number) {
  return (b[at]! << 8) | b[at + 1]!
}
function u32be(b: Uint8Array, at: number) {
  return b[at]! * 0x1000000 + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!)
}
