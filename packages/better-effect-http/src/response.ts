export type HttpResponse<A> = Readonly<{
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly url: string
  readonly data: A
}>
