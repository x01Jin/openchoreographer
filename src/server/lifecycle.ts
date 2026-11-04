export type Registration = { dispose: () => Promise<void> }
export type Handle = { key: string; epoch: number }

function normalizeKey(location: { directory: string }): string {
  const raw = (location.directory ?? "").replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? raw.toLowerCase() : raw
}

export function createRegistrationScope(): {
  take(location: { directory: string }): Promise<Handle>
  install(handle: Handle, registrations: Registration[]): boolean
  forget(handle: Handle, registrations: Registration[]): void
} {
  const entries = new Map<string, { epoch: number; live: Registration[] }>()
  return {
    async take(location: { directory: string }): Promise<Handle> {
      const key = normalizeKey(location)
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = { epoch: 0, live: [] }
        entries.set(key, entry)
      }
      const epoch = ++entry.epoch
      const previous = entry.live
      entry.live = []
      await Promise.allSettled(previous.map((registration) => registration.dispose()))
      return { key, epoch }
    },
    install(handle: Handle, registrations: Registration[]): boolean {
      const entry = entries.get(handle.key)
      if (entry === undefined || entry.epoch !== handle.epoch) return false
      entry.live = registrations
      return true
    },
    forget(handle: Handle, registrations: Registration[]): void {
      const entry = entries.get(handle.key)
      if (entry !== undefined && entry.live === registrations) entry.live = []
    },
  }
}
