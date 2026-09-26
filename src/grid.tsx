// The scrollable grid of photos taken in the area the map shows, newest
// first. Only the rows on screen (plus one screen above and below) are
// mounted, so a few thousand photos cost a few dozen cells; thumbnails load
// through the shared texture cache as cells come into view.
import { createMemo, createPan, createScroll, createSignal, For, getBoundingBox, onLayout, Show, untrack } from "@solidrt/core"
import type { Photo } from "./db"
import { useCachedTexture, type TextureCache } from "./tiles"

type NodeRef = { id: number }

const CARD = "#181b22"
const TEXT = "#e8eaf0"
const MUTED = "#7d8494"
const ACCENT = "#4f8cff"
const GAP = 4
const TARGET = 112

/** Cache key of a photo's thumbnail: a changed file (new mtime) gets a new one. */
export const thumbKey = (p: Photo) => `${p.id}-${p.mtime}`

function Cell(props: { photo: Photo; thumbs: TextureCache; selected: boolean }) {
  let tex = useCachedTexture(untrack(() => props.thumbs), () => thumbKey(props.photo))
  return (
    <>
      <d-rect color={CARD} radius={6} />
      <Show when={tex()}>{(t) => <d-texture src={t()} fit="cover" radius={6} />}</Show>
      <Show when={props.selected}>
        <d-rect color={ACCENT} radius={6} drawStyle="stroke" strokeWidth={3} />
      </Show>
    </>
  )
}

export function PhotoGrid(props: {
  photos: Photo[]
  /** Photos in the area, which may be more than the grid holds. */
  total: number
  thumbs: TextureCache
  selected: number | null
  onOpen: (index: number) => void
}) {
  let viewport: NodeRef | undefined
  let content: NodeRef | undefined
  let [box, setBox] = createSignal<[number, number]>([0, 0])
  onLayout(() => {
    let b = viewport && getBoundingBox(viewport)
    if (!b) return
    let [w, h] = untrack(box)
    if (b.width !== w || b.height !== h) setBox([b.width, b.height])
  })
  let scroll = createScroll(() => viewport, () => content)
  let panned = false
  let pan = createPan({
    axis: "vertical",
    onPanStart: () => (panned = true),
    onPanMove: (_dx, dy) => scroll.scrollBy({ y: -dy }),
    onPanEnd: () => queueMicrotask(() => (panned = false)),
  })

  let layout = createMemo(() => {
    let [w] = box()
    let cols = Math.max(2, Math.floor((w + GAP) / (TARGET + GAP)))
    let cell = w > 0 ? (w - GAP * (cols - 1)) / cols : 0
    return { cols, cell, rows: Math.ceil(props.photos.length / cols) }
  })
  let shown = createMemo(() => {
    let { cols, cell, rows } = layout()
    if (!cell) return []
    let pitch = cell + GAP
    let top = scroll.offset().y
    let first = Math.max(0, Math.floor((top - box()[1]) / pitch))
    let last = Math.min(rows - 1, Math.ceil((top + 2 * box()[1]) / pitch))
    let out: { photo: Photo; index: number }[] = []
    for (let i = first * cols; i < Math.min(props.photos.length, (last + 1) * cols); i++) out.push({ photo: props.photos[i]!, index: i })
    return out
  })

  return (
    <view flexGrow={1} minHeight={0} gap={8}>
      <text fontSize={14} color={MUTED}>
        <span fontWeight={700} color={TEXT}>{`${props.total} ${props.total === 1 ? "photo" : "photos"}`}</span>
        {props.total > props.photos.length ? ` in this area · newest ${props.photos.length} shown` : " in this area · newest first"}
      </text>
      <view
        ref={(n: NodeRef) => (viewport = n)}
        flexGrow={1}
        minHeight={0}
        overflow="hidden"
        scrollY={scroll.offset().y}
        onWheel={(e) => scroll.scrollBy({ y: e.deltaY })}
        {...pan.handlers}
      >
        <view
          ref={(n: NodeRef) => (content = n)}
          position="relative"
          flexShrink={0}
          height={Math.max(0, layout().rows * (layout().cell + GAP) - GAP)}
        >
          <For each={shown()} keyed={(s) => s.photo.id}>
            {(s) => (
              <view
                position="absolute"
                left={(s().index % layout().cols) * (layout().cell + GAP)}
                top={Math.floor(s().index / layout().cols) * (layout().cell + GAP)}
                width={layout().cell}
                height={layout().cell}
                onPointerUp={() => !panned && props.onOpen(s().index)}
              >
                <Cell photo={s().photo} thumbs={props.thumbs} selected={props.selected === s().photo.id} />
              </view>
            )}
          </For>
        </view>
        <Show when={props.photos.length === 0}>
          <view paddingTop={30} alignItems="center">
            <text fontSize={14} color={MUTED}>No located photos in this part of the map.</text>
          </view>
        </Show>
      </view>
    </view>
  )
}
