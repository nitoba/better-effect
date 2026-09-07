import type { HttpSchema, SchemaOutput } from '../../schema'

export type SseMessage<Name extends string = string, Data = string> = Readonly<{
  readonly event: Name
  readonly data: Data
  readonly id: string | undefined
  readonly lastEventId: string
}>

export type SseEventMap = Readonly<Record<string, HttpSchema>>

export type SseEventMessage<Events extends SseEventMap> = {
  readonly [Name in keyof Events & string]: SseMessage<Name, SchemaOutput<Events[Name]>>
}[keyof Events & string]

export type SseTimeout = Readonly<{
  readonly headersMs?: number
  readonly readIdleMs?: number
  readonly totalMs?: number | false
}>

export type SseLimits = Readonly<{
  readonly maxLineBytes?: number
  readonly maxEventBytes?: number
  readonly maxBufferedEvents?: number
  readonly maxBufferBytes?: number
}>

export type SseRequestOptions = Readonly<{
  readonly method?: string
  readonly query?: Record<string, string | number | boolean | undefined>
  readonly headers?: RequestInit['headers']
  readonly body?: unknown
  readonly signal?: AbortSignal
  readonly reconnect?: false
  readonly timeout?: SseTimeout
  readonly limits?: SseLimits
}>

export type SseRawOptions = SseRequestOptions &
  Readonly<{
    readonly schema?: never
    readonly events?: never
  }>

export type SseSchemaOptions<Schema extends HttpSchema> = SseRequestOptions &
  Readonly<{
    readonly schema: Schema
    readonly events?: never
  }>

export type SseEventsOptions<Events extends SseEventMap> = SseRequestOptions &
  Readonly<{
    readonly events: Events
    readonly schema?: never
  }>

export type SseOptions<Schema extends HttpSchema = never, Events extends SseEventMap = never> =
  | (Schema extends never ? never : SseSchemaOptions<Schema>)
  | (Events extends never ? never : SseEventsOptions<Events>)
  | SseRawOptions
