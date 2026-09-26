// The Folders & settings page: which folders are indexed, a small folder
// browser to add one, the scan status, the map background choice and, on
// Android, the photo-access request.
import { createMemo, createPan, createScroll, createSignal, For, onWindowBlur, onWindowFocus, Show, untrack } from "@solidrt/core"
import { createQueryRow, type Database } from "@solidrt/core/data"
import { homedir } from "flux:process"
import { dir } from "flux:fs"
import { isAndroid, PHOTO_PERMISSIONS, requestPermission } from "./android"

type NodeRef = { id: number }

const CARD = "#181b22"
const LINE = "#262a33"
const TEXT = "#e8eaf0"
const MUTED = "#7d8494"
const ACCENT = "#4f8cff"
const DANGER = "#e5484d"

export type ScanState = {
  running: boolean
  files: number
  folder: string
  /** Folders the last scan could not list. */
  unreadable: string[]
  /** Subfolders the last scan was not allowed to open. */
  blocked: string[]
}

export type Folder = { id: number; path: string }

const ANDROID_ROOT = "/storage/emulated/0"

/** Where the browser opens, and the one-tap suggestions. */
function places(): { start: string; suggestions: string[] } {
  if (isAndroid) {
    return {
      start: ANDROID_ROOT,
      suggestions: [`${ANDROID_ROOT}/DCIM`, `${ANDROID_ROOT}/Pictures`, `${ANDROID_ROOT}/Download`],
    }
  }
  let home = homedir() ?? "/"
  return { start: home, suggestions: [`${home}/Pictures`, `${home}/Desktop`, `${home}/Downloads`, `${home}/Documents`] }
}

function Button(props: { label: string; onPress: () => void; primary?: boolean; color?: string; disabled?: boolean }) {
  return (
    <view
      height={40}
      paddingLeft={14}
      paddingRight={14}
      alignItems="center"
      justifyContent="center"
      onPointerUp={() => !props.disabled && props.onPress()}
    >
      <Show when={props.primary} fallback={<d-rect color={LINE} radius={10} drawStyle="stroke" strokeWidth={1.5} />}>
        <d-rect color={props.disabled ? LINE : ACCENT} radius={10} />
      </Show>
      <text fontSize={15} fontWeight={600} color={props.primary ? "#ffffff" : (props.color ?? ACCENT)}>
        {props.label}
      </text>
    </view>
  )
}

function Section(props: { title: string; children?: any }) {
  return (
    <view gap={10}>
      <text fontSize={13} fontWeight={700} color={MUTED}>{props.title.toUpperCase()}</text>
      {props.children}
    </view>
  )
}

function FolderRow(props: { db: Database; folder: Folder; unreadable: boolean; blocked: string[]; onRemove: () => void }) {
  let path = untrack(() => props.folder.path)
  // Every photo under the folder: paths from "<path>/" up to "<path>0" ("0" follows "/").
  let counts = createQueryRow(props.db, "SELECT COUNT(*) AS total, COUNT(lat) AS located FROM photos WHERE path > ? AND path < ?", [
    `${path}/`,
    `${path}0`,
  ])
  return (
    <view flexDirection="row" alignItems="center" gap={10} paddingLeft={14} paddingRight={4} minHeight={56}>
      <d-rect color={CARD} radius={12} />
      <view flexGrow={1} minWidth={0} paddingTop={8} paddingBottom={8} gap={2}>
        <text fontSize={15} color={TEXT}>{props.folder.path}</text>
        <text fontSize={12} color={props.unreadable ? DANGER : MUTED}>
          {props.unreadable
            ? "Can't read this folder"
            : `${counts()?.total ?? 0} photos · ${counts()?.located ?? 0} with a location`}
        </text>
        <Show when={props.blocked.length > 0}>
          <text fontSize={12} color={DANGER}>
            {`Not allowed to open ${props.blocked.map((b) => b.split("/").pop()).join(", ")}` +
              (isAndroid ? "" : ". macOS protects the Photos library; export photos to a normal folder, or give the app Full Disk Access.")}
          </text>
        </Show>
      </view>
      <view width={40} height={40} alignItems="center" justifyContent="center" onPointerUp={props.onRemove}>
        <text fontSize={22} color={MUTED}>×</text>
      </view>
    </view>
  )
}

/** Browse the file system and pick a folder to index. */
function FolderBrowser(props: { onPick: (path: string) => void; onCancel: () => void }) {
  let [path, setPath] = createSignal(places().start)
  let listing = createMemo(async () => {
    let p = path()
    try {
      let entries = await dir(p).entries()
      return {
        ok: true,
        folders: entries
          .filter((e) => e.type === "directory" && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b)),
      }
    } catch {
      return { ok: false, folders: [] as string[] }
    }
  })
  let up = () => {
    let p = path()
    let i = p.lastIndexOf("/")
    setPath(i <= 0 ? "/" : p.slice(0, i))
  }
  let enter = (name: string) => setPath((p) => (p === "/" ? `/${name}` : `${p}/${name}`))
  return (
    <view gap={8} padding={12}>
      <d-rect color={CARD} radius={12} />
      <text fontSize={15} fontWeight={600} color={TEXT}>{path()}</text>
      <Show when={listing().ok} fallback={<text fontSize={13} color={DANGER}>This folder can't be opened (no permission?).</text>}>
        <view gap={2}>
          <Show when={path() !== "/"}>
            <view height={36} justifyContent="center" paddingLeft={8} onPointerUp={up}>
              <text fontSize={15} color={ACCENT}>↑ Up</text>
            </view>
          </Show>
          <For each={listing().folders} keyed={(f) => f}>
            {(name) => (
              <view height={36} flexDirection="row" alignItems="center" paddingLeft={8} paddingRight={8} onPointerUp={() => enter(name())}>
                <text flexGrow={1} minWidth={0} fontSize={15} color={TEXT} maxLines={1}>{name()}</text>
                <text fontSize={17} color={MUTED}>›</text>
              </view>
            )}
          </For>
          <Show when={listing().folders.length === 0}>
            <text fontSize={13} color={MUTED}>No subfolders.</text>
          </Show>
        </view>
      </Show>
      <view flexDirection="row" gap={8} flexWrap="wrap" paddingTop={4}>
        <Button label="Add this folder" primary onPress={() => props.onPick(path())} />
        <Button label="Cancel" onPress={props.onCancel} color={MUTED} />
      </view>
    </view>
  )
}

// Android shows one permission dialog at a time: ask for the next once the
// window has its focus back (or at once when no dialog appeared).
function waitForDialog(): Promise<void> {
  return new Promise((resolve) => {
    let blurred = false
    let offBlur = onWindowBlur(() => (blurred = true))
    let offFocus = onWindowFocus(() => blurred && done())
    let timer = setTimeout(() => !blurred && done(), 1000)
    function done() {
      offBlur()
      offFocus()
      clearTimeout(timer)
      resolve()
    }
  })
}

async function requestPhotoAccess() {
  for (let permission of PHOTO_PERMISSIONS) {
    if (!requestPermission(permission)) continue
    await waitForDialog()
  }
}

export function FoldersPage(props: {
  db: Database
  folders: Folder[]
  scan: ScanState
  totals: { total: number; located: number }
  tiles: boolean
  onAdd: (path: string) => void
  onRemove: (folder: Folder) => void
  onScan: () => void
  onTiles: (on: boolean) => void
}) {
  let [browsing, setBrowsing] = createSignal(false)
  let suggestions = createMemo(async () => {
    let taken = new Set(props.folders.map((f) => f.path))
    let out: string[] = []
    for (let p of places().suggestions) {
      if (taken.has(p)) continue
      try {
        if (await dir(p).exists()) out.push(p)
      } catch {}
    }
    return out
  })

  let viewport: NodeRef | undefined
  let content: NodeRef | undefined
  let scroll = createScroll(() => viewport, () => content)
  let pan = createPan({ axis: "vertical", onPanMove: (_dx, dy) => scroll.scrollBy({ y: -dy }) })

  return (
    <view
      ref={(n: NodeRef) => (viewport = n)}
      flexGrow={1}
      minHeight={0}
      overflow="hidden"
      scrollY={scroll.offset().y}
      onWheel={(e) => scroll.scrollBy({ y: e.deltaY })}
      {...pan.handlers}
    >
      <view ref={(n: NodeRef) => (content = n)} flexShrink={0} gap={22} paddingBottom={24}>
        <Section title="Folders to index">
          <For each={props.folders} keyed={(f) => f.id}>
            {(f) => (
              <FolderRow
                db={props.db}
                folder={f()}
                unreadable={props.scan.unreadable.includes(f().path)}
                blocked={props.scan.blocked.filter((b) => b.startsWith(`${f().path}/`))}
                onRemove={() => props.onRemove(f())}
              />
            )}
          </For>
          <Show when={props.folders.length === 0 && !browsing()}>
            <text fontSize={14} color={MUTED}>No folders yet. Add the folders your photos are in.</text>
          </Show>
          <Show
            when={browsing()}
            fallback={
              <view gap={8}>
                <Show when={(suggestions() ?? []).length > 0}>
                  <view flexDirection="row" flexWrap="wrap" gap={8}>
                    <For each={suggestions() ?? []} keyed={(p) => p}>
                      {(p) => <Button label={`+ ${p().split("/").pop()}`} onPress={() => props.onAdd(p())} />}
                    </For>
                  </view>
                </Show>
                <view flexDirection="row">
                  <Button label="Browse for a folder…" onPress={() => setBrowsing(true)} />
                </view>
              </view>
            }
          >
            <FolderBrowser
              onPick={(p) => {
                setBrowsing(false)
                props.onAdd(p)
              }}
              onCancel={() => setBrowsing(false)}
            />
          </Show>
        </Section>

        <Section title="Index">
          <text fontSize={15} color={TEXT}>
            {`${props.totals.total} photos indexed · ${props.totals.located} with a location`}
          </text>
          <text fontSize={13} color={MUTED}>
            {props.scan.running
              ? `Scanning… ${props.scan.files} files looked at${props.scan.folder ? ` (${props.scan.folder.split("/").pop()})` : ""}`
              : "New and changed photos are picked up at every start, or now:"}
          </text>
          <view flexDirection="row">
            <Button label={props.scan.running ? "Scanning…" : "Scan now"} primary disabled={props.scan.running} onPress={props.onScan} />
          </view>
        </Section>

        <Show when={isAndroid}>
          <Section title="Photo access">
            <text fontSize={13} color={MUTED}>
              Android asks before an app may read your photos, and again before it may see where they were taken.
              If folders show no photos, allow both.
            </text>
            <view flexDirection="row">
              <Button label="Allow photo access" onPress={() => requestPhotoAccess().then(props.onScan)} />
            </view>
          </Section>
        </Show>

        <Section title="Map background">
          <view flexDirection="row" gap={6} padding={4}>
            <d-rect color={CARD} radius={12} />
            <Segment label="OpenStreetMap" active={props.tiles} onSelect={() => props.onTiles(true)} />
            <Segment label="Off" active={!props.tiles} onSelect={() => props.onTiles(false)} />
          </view>
          <text fontSize={13} color={MUTED}>
            {props.tiles
              ? "Map tiles come from tile.openstreetmap.org (OpenStreetMap Foundation; no account, no tracking) and are kept on this device after the first download. Your photos and their locations never leave the device."
              : "No network use at all: the heatmap is drawn on a plain grid."}
          </text>
        </Section>
      </view>
    </view>
  )
}

function Segment(props: { label: string; active: boolean; onSelect: () => void }) {
  return (
    <view flexGrow={1} flexBasis={0} height={36} alignItems="center" justifyContent="center" onPointerDown={props.onSelect}>
      <Show when={props.active}>
        <d-rect color={ACCENT} radius={9} />
      </Show>
      <text fontSize={14} fontWeight={600} color={props.active ? "#ffffff" : MUTED}>{props.label}</text>
    </view>
  )
}
