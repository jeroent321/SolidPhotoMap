// One photo over the whole app: the full image (decoded in the thumbs
// isolate, the grid thumbnail standing in while it loads), its date and
// file name, and previous / next through the list it was opened from.
import { createEffect, createSignal, env, Show, untrack } from "@solidrt/core"
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
      // Enough pixels for the whole window on this display, capped at what
      // every GPU takes as one texture.
      let max = untrack(() => Math.min(4096, Math.ceil(Math.max(env.windowSize.width, env.windowSize.height) * env.displayScale)))
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

  return (
    <view position="absolute" left={0} right={0} top={0} bottom={0} onPointerDown={() => {}}>
      <d-rect color="#000000f2" />
      <Show when={full() ?? thumb()}>
        {(t) => <texture src={t()} fit="contain" position="absolute" left={12} right={12} top={12} bottom={12} />}
      </Show>
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
        <view position="absolute" left={12} top={0} bottom={0} justifyContent="center" pointerEvents="none">
          <RoundButton label="‹" size={28} onPress={props.onPrev} />
        </view>
      </Show>
      <Show when={props.index < props.count - 1}>
        <view position="absolute" right={12} top={0} bottom={0} justifyContent="center" pointerEvents="none">
          <RoundButton label="›" size={28} onPress={props.onNext} />
        </view>
      </Show>
      <view position="absolute" right={12} top={12}>
        <RoundButton label="×" size={26} onPress={props.onClose} />
      </view>
    </view>
  )
}
