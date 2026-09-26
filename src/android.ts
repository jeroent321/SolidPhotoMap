// Android photo access. Reading the camera folder needs a runtime
// permission (READ_MEDIA_IMAGES from Android 13, READ_EXTERNAL_STORAGE
// before), and reading the GPS position inside a photo's EXIF block needs
// ACCESS_MEDIA_LOCATION on top: without it Android hands the app the file
// with the location zeroed out. tools/android-manifest.ts declares all
// three in the APK; this module shows the system permission dialogs.
//
// SolidRT has no permission API, but its Android runner is SDL3, whose
// SDL_RequestAndroidPermission shows the dialog. It is reached through
// flux:ffi. The call takes a completion callback, which SDL invokes later on
// the Java thread - a JS callback cannot run there, so the callback handed
// over is SDL's own SDL_free (called as SDL_free(userdata) with a null
// userdata, a no-op). The outcome is read back the practical way: by
// scanning again once the dialog has closed and the window has focus.
import { platform } from "flux:process"
import { Library } from "flux:ffi"

export const isAndroid = platform === "android"

export const PHOTO_PERMISSIONS = [
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.ACCESS_MEDIA_LOCATION",
]

let request: ((permission: string) => boolean) | null = null

function cString(s: string): Uint8Array {
  let bytes = new TextEncoder().encode(s)
  let out = new Uint8Array(bytes.length + 1)
  out.set(bytes)
  return out
}

function bind(): (permission: string) => boolean {
  const RTLD_NOW = 2
  let dl = new Library("libdl.so", {
    dlopen: { args: ["ptr", "i32"], returns: "ptr" },
    dlsym: { args: ["ptr", "ptr"], returns: "ptr" },
  })
  let { dlopen, dlsym } = dl.symbols
  let handle = dlopen!(cString("libSDL3.so"), RTLD_NOW)
  if (!handle) throw new Error("libSDL3.so is not loaded")
  let noop = dlsym!(handle, cString("SDL_free"))
  if (!noop) throw new Error("SDL_free not found")
  let sdl = new Library("libSDL3.so", {
    SDL_RequestAndroidPermission: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  })
  let { SDL_RequestAndroidPermission } = sdl.symbols
  return (permission) => ((SDL_RequestAndroidPermission!(cString(permission), noop, 0) as number) & 0xff) !== 0
}

/**
 * Asks for one permission; the system shows its dialog unless the answer is
 * already known. Returns false when the request could not be made.
 */
export function requestPermission(permission: string): boolean {
  if (!isAndroid) return false
  try {
    request ??= bind()
    return request(permission)
  } catch (e) {
    console.error("permission request failed:", e)
    return false
  }
}
