export type HttpOptions = Readonly<{
  readonly baseURL?: string
  readonly timeout?: number
  readonly expectedStatuses?: readonly number[]
}>

export const validateHttpOptions = (options: HttpOptions): string | undefined => {
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0))
    return 'timeout must be a finite non-negative number'
  if (
    options.expectedStatuses?.some(
      (status) => !Number.isInteger(status) || status < 100 || status > 599
    )
  )
    return 'expectedStatuses must contain valid HTTP statuses'
  return undefined
}
