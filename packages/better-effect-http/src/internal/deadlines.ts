export type Deadline = Readonly<{ signal: AbortSignal; dispose: () => void; timeout: number }>

export const deadline = (timeout: number | undefined, parent?: AbortSignal): Deadline | undefined => {
  if (timeout === undefined) return undefined
  const controller = new AbortController()
  const reason = new Error(`HTTP timeout after ${timeout}ms`)
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(reason), timeout)
  const onAbort = (): void => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) onAbort()
    else parent.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timeout,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      parent?.removeEventListener('abort', onAbort)
    }
  }
}
