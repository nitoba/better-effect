export type SignalLink = Readonly<{ signal: AbortSignal; dispose: () => void }>

export const linkSignals = (...signals: readonly (AbortSignal | undefined)[]): SignalLink => {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 0) return { signal: new AbortController().signal, dispose: () => {} }
  if (active.length === 1) return { signal: active[0]!, dispose: () => {} }
  const controller = new AbortController()
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const [source, listener] of listeners) source.removeEventListener('abort', listener)
    listeners.length = 0
  }
  const abortFrom = (source: AbortSignal): void => {
    if (controller.signal.aborted) return
    controller.abort(source.reason)
    dispose()
  }
  for (const source of active) {
    if (source.aborted) {
      abortFrom(source)
      break
    }
    const listener = (): void => abortFrom(source)
    listeners.push([source, listener])
    source.addEventListener('abort', listener, { once: true })
  }
  return { signal: controller.signal, dispose }
}
