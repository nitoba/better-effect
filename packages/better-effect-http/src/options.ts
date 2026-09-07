export type HttpOptions = Readonly<{
  readonly baseURL?: string
  readonly timeout?: number | Readonly<{ readonly attemptMs?: number; readonly totalMs?: number | false }>
  readonly expectedStatuses?: readonly number[]
}>

export const validateHttpOptions = (options: HttpOptions): string | undefined => {
  const timeouts = typeof options.timeout === 'number' ? [options.timeout] : options.timeout
    ? [options.timeout.attemptMs, options.timeout.totalMs === false ? undefined : options.timeout.totalMs]
    : []
  if (timeouts.some((timeout) => timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)))
    return 'timeout must be a finite non-negative number'
  if (
    options.expectedStatuses?.some(
      (status) => !Number.isInteger(status) || status < 100 || status > 599
    )
  )
    return 'expectedStatuses must contain valid HTTP statuses'
  return undefined
}
