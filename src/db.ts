// The app's one database, photos.db, in the app's private storage folder
// (a relative path: on Android the app's private data directory, on the
// desktop the client's data tree under ~/.solidrt). It holds the indexed
// photos, the chosen folders and a few settings. Nothing in it leaves the
// device.
import { Database } from "@solidrt/core/data"
import type { Found } from "./indexer"

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
  return db
}

export function saveFound(db: Database, found: Found[]) {
  if (!found.length) return Promise.resolve([])
  let now = Date.now()
  return db.transaction(
    found.map((f): [string, (string | number | null)[]] => [
      `INSERT INTO photos (path, size, mtime, lat, lon, taken, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, lat = excluded.lat,
         lon = excluded.lon, taken = excluded.taken, indexed_at = excluded.indexed_at`,
      [f.path, f.size, f.mtime, f.lat, f.lon, f.taken, now],
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
