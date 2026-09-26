"use isolate"
// The folder scanner, off the UI thread. It walks the chosen folders, reads
// the EXIF block of every photo it has not seen before (or that changed since:
// size or mtime differ) and streams what it found back to the main thread,
// which owns every write to the database (createQuery only sees writes made
// on the main connection).
//
// The isolate opens photos.db read-only once per scan, to know which files
// are already indexed and unchanged.
import { dir, file } from "flux:fs"
import { Database } from "flux:sqlite"
import { readPhotoMeta, PHOTO_EXTENSIONS } from "./exif"

export type Found = {
  path: string
  size: number
  mtime: number
  lat: number | null
  lon: number | null
  taken: string | null
}

export type ScanStep =
  | { kind: "progress"; found: Found[]; files: number; folder: string }
  | {
      kind: "done"
      files: number
      /** Indexed paths no longer on disk (under a folder that could be listed). */
      removed: string[]
      /** Folders that could not be listed: their rows are left alone. */
      unreadable: string[]
      /** Subfolders the OS would not open (macOS's Photos Library, for one). */
      blocked: string[]
    }

const BATCH = 200

export async function* scan(folders: string[]): AsyncGenerator<ScanStep> {
  let known = new Map<string, string>()
  try {
    let db = await Database.open("photos.db", "ro")
    for (let row of await db.query("SELECT path, size, mtime FROM photos").all()) {
      known.set(row.path as string, `${row.size}:${row.mtime}`)
    }
    await db.close()
  } catch {
    // First run: no database yet, everything is new.
  }

  let seen = new Set<string>()
  let unreadable: string[] = []
  let blocked: string[] = []
  let found: Found[] = []
  let files = 0
  let lastYield = 0

  for (let root of folders) {
    let stack = [root]
    let rootListed = false
    while (stack.length) {
      let folder = stack.pop()!
      let entries
      try {
        entries = await dir(folder).entries()
      } catch {
        if (folder === root) unreadable.push(root)
        else blocked.push(folder)
        continue
      }
      if (folder === root) rootListed = true
      // Visit subfolders in name order: the stack pops the last pushed first.
      entries.sort((a, b) => (a.name < b.name ? 1 : -1))
      for (let entry of entries) {
        // Hidden entries: .thumbnails, .trashed-*, .Spotlight-V100 and friends.
        if (entry.name.startsWith(".")) continue
        let path = folder.endsWith("/") ? folder + entry.name : `${folder}/${entry.name}`
        if (entry.type === "directory") {
          stack.push(path)
          continue
        }
        if (entry.type !== "file") continue
        let dot = entry.name.lastIndexOf(".")
        if (dot < 0 || !PHOTO_EXTENSIONS.has(entry.name.slice(dot + 1).toLowerCase())) continue
        if (seen.has(path)) continue
        seen.add(path)
        files++
        let f = file(path)
        let stat
        try {
          stat = await f.stat()
        } catch {
          continue
        }
        let mtime = stat.mtime ?? 0
        if (known.get(path) === `${stat.size}:${mtime}`) continue
        let meta = { lat: null as number | null, lon: null as number | null, taken: null as string | null }
        try {
          meta = await readPhotoMeta((offset, length) => f.read(offset, Math.max(0, Math.min(length, stat.size - offset))), stat.size)
        } catch {
          // Unreadable or malformed: indexed without a position, so it is
          // not re-read on every scan.
        }
        found.push({ path, size: stat.size, mtime, ...meta })
        if (found.length >= BATCH) {
          yield { kind: "progress", found, files, folder }
          found = []
          lastYield = files
        }
      }
      if (files - lastYield >= 500 || found.length) {
        yield { kind: "progress", found, files, folder }
        found = []
        lastYield = files
      }
    }
    void rootListed
  }

  let removed: string[] = []
  for (let path of known.keys()) {
    if (seen.has(path)) continue
    if ([...unreadable, ...blocked].some((root) => path.startsWith(root + "/"))) continue
    removed.push(path)
  }
  yield { kind: "done", files, removed, unreadable, blocked }
}
