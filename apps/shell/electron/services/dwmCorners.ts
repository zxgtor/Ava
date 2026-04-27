import { BrowserWindow } from 'electron'
import koffi from 'koffi'

// ── DWM attribute codes ─────────────────────────────────────────────
// DWMWA_WINDOW_CORNER_PREFERENCE is Win11+ only. On Win10 the call
// returns a non-zero HRESULT (attribute unknown) and is silently ignored.

const DWMWA_WINDOW_CORNER_PREFERENCE = 33

const PREF_VALUE = {
  default: 0,
  square: 1,
  round: 2,
  'round-small': 3,
} as const

export type CornerPreference = keyof typeof PREF_VALUE

// ── Cached koffi function ──────────────────────────────────────────

type DwmSetWindowAttributeFn = (
  hwnd: Buffer,
  attr: number,
  value: Buffer,
  cbAttribute: number,
) => number

let cachedFn: DwmSetWindowAttributeFn | null = null

function loadDwmFn(): DwmSetWindowAttributeFn | null {
  if (cachedFn) return cachedFn
  try {
    const dwmapi = koffi.load('dwmapi.dll')
    cachedFn = dwmapi.func(
      'long __stdcall DwmSetWindowAttribute(void* hwnd, uint dwAttribute, void* pvAttribute, uint cbAttribute)',
    ) as unknown as DwmSetWindowAttributeFn
    return cachedFn
  } catch (err) {
    console.warn('[dwmCorners] failed to load dwmapi.dll:', err)
    return null
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Apply Win11 system-level rounded corners (DWM) to the given BrowserWindow.
 *
 * - No-op on non-Windows platforms.
 * - On Win10 the DWM attribute is unknown; the call returns a non-zero
 *   HRESULT and is logged but does not throw.
 * - Compatible with `transparent: true` + `frame: false`: the window's
 *   outer shape becomes a rounded rectangle at the OS level, eliminating
 *   the transparent corner gap that exposes the desktop behind CSS-rounded
 *   content.
 *
 * Should be called after `ready-to-show` (HWND must exist).
 */
export function applyWin11RoundedCorners(
  window: BrowserWindow,
  pref: CornerPreference = 'round',
): void {
  if (process.platform !== 'win32') return
  if (window.isDestroyed()) return

  const fn = loadDwmFn()
  if (!fn) return

  try {
    const hwnd = window.getNativeWindowHandle()
    const value = Buffer.alloc(4)
    value.writeUInt32LE(PREF_VALUE[pref])
    const hr = fn(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, value, 4)
    if (hr !== 0) {
      console.warn(
        `[dwmCorners] DwmSetWindowAttribute returned 0x${(hr >>> 0).toString(16).padStart(8, '0')} ` +
          `(likely Win10 — silently ignored)`,
      )
    }
  } catch (err) {
    console.warn('[dwmCorners] failed:', err)
  }
}
