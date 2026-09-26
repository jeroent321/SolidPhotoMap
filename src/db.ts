// The app's one database, photos.db, in the app's private storage folder
// (a relative path: on Android the app's private data directory, on the
// desktop the client's data tree under ~/.solidrt). It holds the indexed
// photos, the chosen folders and a few settings. Nothing in it leaves the
// device.
import { Database } from "@solidrt/core/data"
import type { Found } from "./indexer"
import { mercator } from "./geo"

export async function openDb(): Promise<Database> {
  let db = await Database.open("photos.db", "rw+")
  // WAL lets the indexer and heat isolates read while the UI writes.
  await db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS folders (
      id       INTEGER PRIMARY KEY,
      path     TEXT    NOT NULL UNIQUE,
      added_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id         INTEGER PRIMARY KEY,
      path       TEXT    NOT NULL UNIQUE,
      size       INTEGER NOT NULL,
      mtime      INTEGER NOT NULL,
      lat        REAL,
      lon        REAL,
      taken      TEXT,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  // Web Mercator position (geo.ts), so the map's visible area is a plain
  // range query. Added after the first version: backfill older rows.
  let columns = await db.query("PRAGMA table_info(photos)").all()
  if (!columns.some((c) => c.name === "mx")) {
    await db.exec("ALTER TABLE photos ADD COLUMN mx REAL; ALTER TABLE photos ADD COLUMN my REAL;")
    let rows = await db.query("SELECT id, lat, lon FROM photos WHERE lat IS NOT NULL").all()
    await db.transaction(
      rows.map((r): [string, number[]] => ["UPDATE photos SET mx = ?, my = ? WHERE id = ?", [...mercator(r.lat as number, r.lon as number), r.id as number]]),
    )
  }
  await db.exec("CREATE INDEX IF NOT EXISTS photos_area ON photos (mx, my)")
  return db
}

/** A located photo as the grid, the map's points and the viewer use it. */
export type Photo = { id: number; path: string; mtime: number; taken: string | null; mx: number; my: number }

export function saveFound(db: Database, found: Found[]) {
  if (!found.length) return Promise.resolve([])
  let now = Date.now()
  return db.transaction(
    found.map((f): [string, (string | number | null)[]] => [
      `INSERT INTO photos (path, size, mtime, lat, lon, mx, my, taken, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, lat = excluded.lat,
         lon = excluded.lon, mx = excluded.mx, my = excluded.my, taken = excluded.taken, indexed_at = excluded.indexed_at`,
      [f.path, f.size, f.mtime, f.lat, f.lon, ...(f.lat != null && f.lon != null ? mercator(f.lat, f.lon) : [null, null]), f.taken, now],
    ]),
  )
}

export async function removePaths(db: Database, paths: string[]) {
  for (let i = 0; i < paths.length; i += 500) {
    let chunk = paths.slice(i, i + 500)
    await db.run(`DELETE FROM photos WHERE path IN (${chunk.map(() => "?").join(",")})`, chunk)
  }
}

export async function getSetting(db: Database, key: string): Promise<string | undefined> {
  let row = await db.query("SELECT value FROM settings WHERE key = ?").get([key])
  return row?.value as string | undefined
}

export function setSetting(db: Database, key: string, value: string) {
  return db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
}
