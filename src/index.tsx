// Photo Map: a heatmap of where your photos were taken, read from the GPS
// position in each photo's EXIF block.
// - folders: chosen in the Folders page; every start (and "Scan now")
//   re-walks them in the indexer isolate, reading only new or changed files.
// - storage: photos.db in the app's private storage folder holds the index
//   (path, size, mtime, position, capture time), the folders and settings.
//   Photos and positions never leave the device.
// - map: OpenStreetMap tiles, cached on disk, or no tiles at all (settings).
// - heat: computed per map tile in the heat isolate, recomputed while an
//   index runs so the map fills in as photos are found.
import {
  render,
  createEffect,
  createMemo,
  createSignal,
  onBack,
  onSettled,
  safeArea,
  untrack,
  Loading,
  Show,
} from "@solidrt/core"
import { createQuery, createQueryRow, type Database } from "@solidrt/core/data"
import { createTexture } from "@solidrt/core/gpu"
import { isolate } from "flux:isolate"
import { registerDebug } from "srt:dev"
import type * as Indexer from "./indexer"
import type * as Heat from "./heat"
import { getSetting, openDb, removePaths, saveFound, setSetting } from "./db"
import { FoldersPage, type Folder, type ScanState } from "./folders"
import { PhotoMap } from "./map"
import { mapTileCache, OSM, TextureCache } from "./tiles"
import type { View } from "./geo"

const BG = "#0f1115"
const CARD = "#181b22"
const TEXT = "#e8eaf0"
const MUTED = "#7d8494"
const ACCENT = "#4f8cff"

const HEAT_SIZE = 64

let indexer = isolate<typeof Indexer>("indexer")
let heat = isolate<typeof Heat>("heat")

const heatCache = new TextureCache(300, async (key) => {
  let [, z, x, y] = key.split("/").map(Number) as [number, number, number, number]
  let pixels = await heat.tile(z, x, y)
  if (!pixels) return null
  return createTexture(pixels, HEAT_SIZE, HEAT_SIZE, { autoFree: false, label: `heat ${key}` })
})
const tileCache = mapTileCache(OSM)

type Boot = { db: Database; view: View | null; tiles: boolean }

async function boot(): Promise<Boot> {
  let db = await openDb()
  let view = await getSetting(db, "view")
  let tiles = await getSetting(db, "tiles")
  return { db, view: view ? (JSON.parse(view) as View) : null, tiles: tiles !== "off" }
}

function Tab(props: { label: string; active: boolean; onSelect: () => void }) {
  return (
    <view flexGrow={1} flexBasis={0} height={34} alignItems="center" justifyContent="center" onPointerDown={props.onSelect}>
      <Show when={props.active}>
        <d-rect color={ACCENT} radius={9} />
      </Show>
      <text fontSize={14} fontWeight={600} color={props.active ? "#ffffff" : MUTED}>{props.label}</text>
    </view>
  )
}

function Main(props: { boot: Boot }) {
  let { db, view: savedView, tiles: savedTiles } = untrack(() => props.boot)
  let folderRows = createQuery(db, "SELECT id, path FROM folders ORDER BY path")
  let folders = createMemo(() => (folderRows() ?? []) as unknown as Folder[])
  let totalsRow = createQueryRow(db, "SELECT COUNT(*) AS total, COUNT(lat) AS located FROM photos")
  let totals = createMemo(() => ({ total: (totalsRow()?.total as number) ?? 0, located: (totalsRow()?.located as number) ?? 0 }))

  let [page, setPage] = createSignal<"map" | "folders">("map")
  let [scan, setScan] = createSignal<ScanState>({ running: false, files: 0, folder: "", unreadable: [], blocked: [] })
  let [heatVersion, setHeatVersion] = createSignal(0)
  let [view, setView] = createSignal<View>(savedView ?? { x: 0.5, y: 0.4, z: 2 })
  let [tilesOn, setTilesOn] = createSignal(savedTiles)
  // Until the map is touched it keeps fitting itself to the photos found so far.
  let [fit, setFit] = createSignal<[number, number, number, number] | null>(null)
  let autoFit = savedView == null

  createEffect(
    () => view(),
    (v) => {
      let timer = setTimeout(() => setSetting(db, "view", JSON.stringify(v)), 800)
      return () => clearTimeout(timer)
    },
    { defer: true },
  )

  let lastHeatLoad = 0
  // Loads run one after another: two overlapping loads could finish out of
  // order and leave the isolate holding the older point set.
  let heatChain = Promise.resolve()
  let reloadHeat = () => (heatChain = heatChain.then(loadHeat, loadHeat))
  let loadHeat = async () => {
    lastHeatLoad = Date.now()
    await heat.load()
    setHeatVersion((v) => v + 1)
    heatCache.clearUnused()
    if (autoFit) {
      let b = await heat.bounds()
      if (b) setFit(b)
    }
  }

  let again = false
  let runScan = async () => {
    if (scan().running) {
      again = true
      return
    }
    setScan({ running: true, files: 0, folder: "", unreadable: [], blocked: [] })
    // Read straight from the database: the folders query may not have caught
    // up with a folder added a moment ago.
    let paths = (await db.query("SELECT path FROM folders").all()).map((r) => r.path as string)
    try {
      for await (let step of indexer.scan(paths)) {
        if (step.kind === "progress") {
          await saveFound(db, step.found)
          setScan((s) => ({ ...s, files: step.files, folder: step.folder }))
          if (step.found.some((f) => f.lat != null) && Date.now() - lastHeatLoad > 2000) reloadHeat()
        } else {
          await removePaths(db, step.removed)
          setScan({ running: false, files: step.files, folder: "", unreadable: step.unreadable, blocked: step.blocked })
        }
      }
    } catch (e) {
      console.error("scan failed:", e)
      setScan((s) => ({ ...s, running: false }))
    }
    await reloadHeat()
    if (again) {
      again = false
      runScan()
    }
  }

  let addFolder = async (path: string) => {
    let clean = path.length > 1 ? path.replace(/\/+$/, "") : path
    await db.run("INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)", [clean, Date.now()])
    runScan()
  }
  let removeFolder = async (f: Folder) => {
    await db.run("DELETE FROM folders WHERE id = ?", [f.id])
    runScan()
  }
  let chooseTiles = (on: boolean) => {
    setTilesOn(on)
    setSetting(db, "tiles", on ? "osm" : "off")
  }

  onSettled(() => {
    // The folder list query resolves asynchronously; scan once it has.
    reloadHeat().then(() => runScan())
  })
  // Dev tooling hooks (only dev clients ever call them).
  registerDebug("page", (p: "map" | "folders") => setPage(p))
  registerDebug("addFolder", (path: string) => void addFolder(path))
  registerDebug("view", (v?: View) => (v ? void setView(v) : view()))
  registerDebug("state", () => ({ scan: scan(), totals: totals(), heatVersion: heatVersion(), view: view(), folders: folders() }))

  onBack((e) => {
    if (page() === "folders") {
      e.preventDefault()
      setPage("map")
    }
  })

  return (
    <view flexGrow={1} minHeight={0} gap={12}>
      <view flexDirection="row" alignItems="center" gap={12} paddingLeft={16} paddingRight={16}>
        <text flexGrow={1} fontSize={24} fontWeight={800} color={TEXT}>Photo Map</text>
        <view flexDirection="row" gap={4} padding={3} width={220}>
          <d-rect color={CARD} radius={11} />
          <Tab label="Map" active={page() === "map"} onSelect={() => setPage("map")} />
          <Tab label="Folders" active={page() === "folders"} onSelect={() => setPage("folders")} />
        </view>
      </view>

      <Show
        when={page() === "map"}
        fallback={
          <view flexGrow={1} minHeight={0} paddingLeft={16} paddingRight={16} alignItems="center">
            <view width="100%" maxWidth={640} flexGrow={1} minHeight={0}>
              <FoldersPage
                db={db}
                folders={folders()}
                scan={scan()}
                totals={totals()}
                tiles={tilesOn()}
                onAdd={addFolder}
                onRemove={removeFolder}
                onScan={runScan}
                onTiles={chooseTiles}
              />
            </view>
          </view>
        }
      >
        <view flexGrow={1} minHeight={0} position="relative" onPointerDown={() => (autoFit = false)} onWheel={() => (autoFit = false)}>
          <PhotoMap
            view={view()}
            onView={setView}
            tiles={tilesOn() ? tileCache : null}
            maxTileZoom={OSM.maxZoom}
            attribution={OSM.attribution}
            heat={heatCache}
            heatVersion={heatVersion()}
            fit={fit()}
          />
          <Show when={scan().running}>
            <view position="absolute" left={12} top={12} paddingLeft={12} paddingRight={12} height={32} justifyContent="center" pointerEvents="none">
              <d-rect color="#181b22e6" radius={16} />
              <text fontSize={13} color={TEXT}>{`Indexing… ${scan().files} files`}</text>
            </view>
          </Show>
          <Show when={!scan().running && totals().located === 0}>
            <view position="absolute" left={0} right={0} top={0} bottom={0} alignItems="center" justifyContent="center" pointerEvents="none">
              <view maxWidth={360} margin={16} padding={20} gap={12} alignItems="center">
                <d-rect color="#181b22f0" radius={16} />
                <text fontSize={17} fontWeight={700} color={TEXT}>No photos with a location yet</text>
                <text fontSize={14} color={MUTED} textAlign="center">
                  {folders().length === 0
                    ? "Choose the folders your photos are in, and they will show up here as a heatmap."
                    : "None of the photos in your folders carries a GPS position."}
                </text>
                <view height={40} paddingLeft={16} paddingRight={16} alignItems="center" justifyContent="center" onPointerUp={() => setPage("folders")}>
                  <d-rect color={ACCENT} radius={10} />
                  <text fontSize={15} fontWeight={600} color="#ffffff">Choose folders</text>
                </view>
              </view>
            </view>
          </Show>
        </view>
      </Show>
    </view>
  )
}

function App() {
  let booted = createMemo(() => boot())
  return (
    <window
      title="Photo Map"
      paddingTop={safeArea().top + 14}
      paddingBottom={safeArea().bottom}
      paddingLeft={safeArea().left}
      paddingRight={safeArea().right}
    >
      <d-rect color={BG} />
      <Loading fallback={<text color={MUTED}>Opening…</text>}>
        <Main boot={booted()} />
      </Loading>
    </window>
  )
}

render(() => <App />)
