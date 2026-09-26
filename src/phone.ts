// Phone preview on the desktop: `bun run phone` opens a portrait client with
// SOLIDPHOTOMAP_PHONE=1 in its environment, and the app then behaves as it
// does on Android as far as a desktop window can: Android's status bar and
// navigation bar (with a working Back button) around the app, the phone's
// safe-area insets, Escape as the Back key, finger-sized touch targets, and
// the Android-only settings shown. Reading photos still uses Mac paths.
import { env } from "flux:process"
import { isAndroid } from "./android"

export const simulatePhone = !isAndroid && env.SOLIDPHOTOMAP_PHONE === "1"

/** Touch-first behaviour: a real Android device, or the phone preview. */
export const touchFirst = isAndroid || simulatePhone

/** Heights of the simulated system bars, in logical pixels. */
export const STATUS_BAR = 28
export const NAV_BAR = 48
