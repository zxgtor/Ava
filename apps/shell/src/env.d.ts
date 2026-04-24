/// <reference types="vite/client" />

import type { AvaApi } from '../electron/preload'

declare global {
  interface Window {
    ava: AvaApi
  }
}

export {}
