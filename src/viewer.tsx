// One photo over the whole app: the full image (decoded in the thumbs
// isolate, the grid thumbnail standing in while it loads), its date and
// file name, and previous / next through the list it was opened from.
import { createDoubleTap, createEffect, createSignal, createTransform, env, getBoundingBox, onLayout, pct, Show, untrack } from "@solidrt/core"
import { createTexture, destroyTexture, type TextureId } from "@solidrt/core/gpu"
import type { Isolated } from "flux:isolate"
import type * as Thumbs from "./thumbs"
import type { Photo } from "./db"
import { thumbKey } from "./grid"
import { useCachedTexture, type TextureCache } from "./tiles"

const TEXT = "#e8eaf0"
const MUTED = "#7d8494"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// "2024-07-14 18:03:22" -> "14 Jul 2024, 18:03"
export function formatTaken(taken: string | null): string {
  let m = taken && /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(taken)
  if (!m) return "Date unknown"
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]}`
}

function RoundButton(props: { label: string; onPress: () => void; size?: number }) {
  return (
    <view width={44} height={44} alignItems="center" justifyContent="center" onPointerUp={props.onPress}>
      <d-oval color="#181b22d9" />
      <text fontSize={props.size ?? 22} color={TEXT}>{props.label}</text>
    </view>
  )
}

export function Viewer(props: {
  photo: Photo
  index: number
  count: number
  thumbs: TextureCache
  loader: Isolated<typeof Thumbs>
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}) {
  let loader = untrack(() => props.loader)
  let thumb = useCachedTexture(untrack(() => props.thumbs), () => thumbKey(props.photo))
  let [full, setFull] = createSignal<TextureId | null>(null, { ownedWrite: true })
  let [failed, setFailed] = createSignal(false, { ownedWrite: true })
  createEffect(
    () => props.photo.path,
    (path) => {
      let alive = true
      let tex: TextureId | null = null
      setFailed(false)
      // Twice the pixels the window shows, so zooming in stays sharp for a
      // while, capped at what every GPU takes as one texture.
      let max = untrack(() => Math.min(4096, Math.ceil(2 * Math.max(env.windowSize.width, env.windowSize.height) * env.displayScale)))
      loader.full(path, max).then(
        (img) => {
          if (!alive) return
          if (!img) return setFailed(true)
          tex = createTexture(img.data, img.width, img.height, { autoFree: false, mipmap: true, label: "viewer" })
          setFull(tex)
        },
        () => alive && setFailed(true),
      )
      return () => {
        alive = false
        setFull(null)
        if (tex != null) destroyTexture(tex)
      }
    },
  )
  let name = () => props.photo.path.split("/").pop()

  // Zooming inside the photo: pinch, wheel or double-click. The image view
  // is scaled about its centre and moved by (x, y); a zoom keeps the point
  // under the fingers or the pointer in place, and the image cannot be
  // dragged off its box. A new photo starts unzoomed.
  const MAX_ZOOM = 8
  type Zoom = { s: number; x: number; y: number }
  let [zoom, setZoom] = createSignal<Zoom>({ s: 1, x: 0, y: 0 }, { ownedWrite: true })
  createEffect(
    () => props.photo.id,
    () => {
      setZoom({ s: 1, x: 0, y: 0 })
    },
  )
  let box: { id: number } | undefined
  let size = { w: 0, h: 0 }
  onLayout(() => {
    let b = box && getBoundingBox(box)
    if (b) size = { w: b.width, h: b.height }
  })
  let clamp = (z: Zoom): Zoom => {
    let s = Math.max(1, Math.min(MAX_ZOOM, z.s))
    let mx = ((s - 1) * size.w) / 2
    let my = ((s - 1) * size.h) / 2
    return { s, x: Math.max(-mx, Math.min(mx, z.x)), y: Math.max(-my, Math.min(my, z.y)) }
  }
  // (fx, fy) in the box's own pixels.
  let zoomAt = (z: Zoom, k: number, fx: number, fy: number): Zoom => {
    let s = Math.max(1, Math.min(MAX_ZOOM, z.s * k))
    let r = s / z.s
    let cx = fx - size.w / 2
    let cy = fy - size.h / 2
    return clamp({ s, x: cx - (cx - z.x) * r, y: cy - (cy - z.y) * r })
  }
  let pinch = createTransform({
    onTransformMove: (t) => {
      let z = zoom()
      z = { ...z, x: z.x + t.dx, y: z.y + t.dy }
      if (t.scale !== 1) z = zoomAt(z, t.scale, t.x, t.y)
      setZoom(clamp(z))
    },
  })
  let doubleTap = createDoubleTap({
    onDoubleTap: (at) => setZoom((z) => (z.s > 1 ? { s: 1, x: 0, y: 0 } : zoomAt(z, 2.5, at.localX, at.localY))),
  })

  return (
    <view position="absolute" left={0} right={0} top={0} bottom={0} overflow="hidden">
      <d-rect color="#0b0d11" />
      <view
        ref={(n: { id: number }) => (box = n)}
        position="absolute"
        left={0}
        right={0}
        top={0}
        bottom={0}
        overflow="hidden"
        onWheel={(e) => setZoom((z) => zoomAt(z, 2 ** (-e.deltaY / 240), e.localX, e.localY))}
        {...pinch.handlers}
      >
        <view position="absolute" left={0} right={0} top={0} bottom={0} {...doubleTap.handlers}>
          <view position="absolute" left={8} right={8} top={8} bottom={8} x={zoom().x} y={zoom().y} scale={zoom().s}>
            <Show when={full() ?? thumb()}>
              {(t) => <texture src={t()} fit="contain" position="absolute" left={0} right={0} top={0} bottom={0} />}
            </Show>
          </view>
        </view>
      </view>
      <Show when={failed() && !thumb()}>
        <view position="absolute" left={0} right={0} top={0} bottom={0} alignItems="center" justifyContent="center">
          <text fontSize={15} color={MUTED}>This photo's format can't be shown here yet.</text>
        </view>
      </Show>

      <view position="absolute" left={0} right={0} bottom={0} padding={14} gap={2} pointerEvents="none">
        <d-rect color="#00000099" />
        <text fontSize={16} fontWeight={600} color={TEXT}>{formatTaken(props.photo.taken)}</text>
        <text fontSize={12} color={MUTED} maxLines={1}>{`${name()} · ${props.index + 1} of ${props.count}`}</text>
      </view>
      <Show when={props.index > 0}>
        <view position="absolute" left={12} top={pct(50)} y={-22}>
          <RoundButton label="‹" size={28} onPress={props.onPrev} />
        </view>
      </Show>
      <Show when={props.index < props.count - 1}>
        <view position="absolute" right={12} top={pct(50)} y={-22}>
          <RoundButton label="›" size={28} onPress={props.onNext} />
        </view>
      </Show>
      <view position="absolute" right={12} top={12}>
        <RoundButton label="×" size={26} onPress={props.onClose} />
      </view>
    </view>
  )
}
