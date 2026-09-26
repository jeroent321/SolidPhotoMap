// The map: background tiles with the photo heatmap over them, panned by
// dragging, zoomed by pinching, the mouse wheel or the +/- buttons.
//
// All tiles of the current integer zoom level sit in one detached layer at
// fixed positions (256 px apart, relative to an anchor tile near the
// centre). Panning and fractional zoom only move and scale that layer: three
// property writes per gesture frame, however many tiles are on screen. The
// tile set itself changes only when a tile boundary is crossed.
import { createDoubleTap, createEffect, createMemo, createSignal, createTransform, For, getBoundingBox, onLayout, onSettled, Show, untrack } from "@solidrt/core"
import type { TextureId } from "@solidrt/core/gpu"
import type { TextureCache } from "./tiles"
import { fitBounds, panBy, TILE, zoomAbout, type View } from "./geo"

type NodeRef = { id: number }

const MUTED = "#7d8494"
const TEXT = "#e8eaf0"

/**
 * One tile's texture. `k` is its cache key; when it changes (a new heat
 * version) the old texture stays up until the new one has loaded, so the
 * heatmap updates in place instead of flickering while photos are indexed.
 * Detached (d-*): lives inside the map's d-view layer.
 */
function Tile(props: { cache: TextureCache; k: string; x: number; y: number }) {
  let [tex, setTex] = createSignal<TextureId | null>(null)
  let held: string | null = null
  let cache = untrack(() => props.cache)
  createEffect(
    () => props.k,
    (k) => {
      let alive = true
      cache.acquire(k).then((t) => {
        if (!alive) return cache.release(k)
        let previous = held
        held = k
        setTex(t)
        if (previous) cache.release(previous)
      })
      return () => {
        alive = false
      }
    },
  )
  onSettled(() => () => {
    if (held) cache.release(held)
  })
  return (
    <Show when={tex()}>
      {(t) => <d-texture src={t()} x={props.x} y={props.y} w={TILE} h={TILE} />}
    </Show>
  )
}

type TileRef = { key: string; tx: number; ty: number; wrapped: string }

function ZoomButton(props: { label: string; onPress: () => void }) {
  return (
    <view width={40} height={40} alignItems="center" justifyContent="center" onPointerDown={props.onPress}>
      <d-rect color="#181b22e6" radius={10} />
      <d-rect color="#262a33" radius={10} drawStyle="stroke" strokeWidth={1} />
      <text fontSize={22} color={TEXT}>{props.label}</text>
    </view>
  )
}

export function PhotoMap(props: {
  view: View
  onView: (v: View) => void
  /** Background tiles, or null to draw a plain grid (tiles switched off). */
  tiles: TextureCache | null
  maxTileZoom: number
  attribution: string
  heat: TextureCache
  heatVersion: number
  /** World box to fit into view; a new object re-fits. */
  fit: [number, number, number, number] | null
}) {
  let node: NodeRef | undefined
  let [size, setSize] = createSignal<[number, number]>([0, 0])
  onLayout(() => {
    let box = node && getBoundingBox(node)
    if (!box) return
    let [w, h] = untrack(size)
    if (box.width !== w || box.height !== h) setSize([box.width, box.height])
  })

  // Fit requests wait for the first layout, so the map knows its size.
  createEffect(
    () => [props.fit, size()] as const,
    ([fit, [w, h]], prev) => {
      if (!fit || !w || !h) return
      if (prev && prev[0] === fit && prev[1][0]) return
      props.onView(fitBounds(fit, w, h))
    },
  )

  let tz = createMemo(() => Math.max(0, Math.min(props.maxTileZoom, Math.round(props.view.z))))
  // The anchor tile moves only in steps of 32 tiles, so the tiles'
  // layer positions stay put while panning.
  let anchor = createMemo(
    () => {
      let n = 2 ** tz()
      return [tz(), Math.floor((props.view.x * n) / 32) * 32, Math.floor((props.view.y * n) / 32) * 32] as const
    },
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] },
  )
  let layer = createMemo(() => {
    let [w, h] = size()
    let [t, ax, ay] = anchor()
    let v = props.view
    let world = TILE * 2 ** v.z
    return {
      x: (ax / 2 ** t - v.x) * world + w / 2,
      y: (ay / 2 ** t - v.y) * world + h / 2,
      scale: 2 ** (v.z - t),
    }
  })
  let visible = createMemo((): TileRef[] => {
    let [w, h] = size()
    if (!w || !h) return []
    let t = tz()
    let n = 2 ** t
    let v = props.view
    let world = TILE * 2 ** v.z
    let tx0 = Math.floor((v.x - w / 2 / world) * n)
    let tx1 = Math.floor((v.x + w / 2 / world) * n)
    let ty0 = Math.max(0, Math.floor((v.y - h / 2 / world) * n))
    let ty1 = Math.min(n - 1, Math.floor((v.y + h / 2 / world) * n))
    let out: TileRef[] = []
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        out.push({ key: `${t}/${tx}/${ty}`, tx, ty, wrapped: `${t}/${((tx % n) + n) % n}/${ty}` })
      }
    }
    return out
  })
  let px = (tx: number) => (tx - anchor()[1]) * TILE
  let py = (ty: number) => (ty - anchor()[2]) * TILE

  let gesture = createTransform({
    onTransformMove: (t) => {
      let [w, h] = size()
      let v = panBy(props.view, t.dx, t.dy)
      if (t.scale !== 1) v = zoomAbout(v, t.scale, t.x, t.y, w, h)
      props.onView(v)
    },
  })
  // Double click / double tap zooms in one level about that point. It sits on
  // an inner view of the same box, so both recognizers see the pointer and
  // arbitrate through the arena (a drag steals from the double tap).
  let doubleTap = createDoubleTap({
    onDoubleTap: (at) => {
      let [w, h] = size()
      props.onView(zoomAbout(props.view, 2, at.localX, at.localY, w, h))
    },
  })
  let zoomCentre = (factor: number) => {
    let [w, h] = size()
    props.onView(zoomAbout(props.view, factor, w / 2, h / 2, w, h))
  }

  return (
    <view flexGrow={1} minHeight={0} position="relative">
      <view
        ref={(n: NodeRef) => (node = n)}
        position="absolute"
        left={0}
        right={0}
        top={0}
        bottom={0}
        overflow="hidden"
        onWheel={(e) => {
          let [w, h] = size()
          props.onView(zoomAbout(props.view, 2 ** (-e.deltaY / 240), e.localX, e.localY, w, h))
        }}
        {...gesture.handlers}
      >
        <view position="absolute" left={0} right={0} top={0} bottom={0} {...doubleTap.handlers}>
          <d-rect color="#1b1f27" />
          <d-view x={layer().x} y={layer().y} scale={layer().scale}>
            <Show
              when={props.tiles}
              fallback={
                <For each={visible()} keyed={(t) => t.key}>
                  {(t) => <d-rect x={px(t().tx)} y={py(t().ty)} w={TILE} h={TILE} color="#2a2f3a" drawStyle="stroke" strokeWidth={1} />}
                </For>
              }
            >
              {(cache) => (
                <For each={visible()} keyed={(t) => t.key}>
                  {(t) => <Tile cache={cache()} k={t().wrapped} x={px(t().tx)} y={py(t().ty)} />}
                </For>
              )}
            </Show>
          </d-view>
          {/* Tones the map down so the heat colours carry. */}
          <Show when={props.tiles}>
            <d-rect color="#0f111547" />
          </Show>
          <d-view x={layer().x} y={layer().y} scale={layer().scale}>
            <For each={visible()} keyed={(t) => t.key}>
              {(t) => <Tile cache={props.heat} k={`${props.heatVersion}/${t().wrapped}`} x={px(t().tx)} y={py(t().ty)} />}
            </For>
          </d-view>
        </view>
      </view>

      <view position="absolute" right={12} top={12} gap={8}>
        <ZoomButton label="+" onPress={() => zoomCentre(2)} />
        <ZoomButton label="−" onPress={() => zoomCentre(0.5)} />
      </view>
      <Show when={props.tiles && props.attribution}>
        <view position="absolute" right={0} bottom={0} paddingLeft={6} paddingRight={6} paddingTop={2} paddingBottom={2}>
          <d-rect color="#0f1115b3" radius={[6, 0, 0, 0]} />
          <text fontSize={11} color={MUTED}>{props.attribution}</text>
        </view>
      </Show>
    </view>
  )
}
