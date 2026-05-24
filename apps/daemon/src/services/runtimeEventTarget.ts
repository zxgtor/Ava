export interface RuntimeEventTarget {
  isDestroyed: () => boolean
  send: (channel: string, payload: unknown) => void
}

