/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- the NDJSON description erases one heterogeneous schema boundary after validating options. */
import { executeRequest } from '../../internal/ofetch-transport'
import type { TransportOptions, TransportRequestOptions } from '../../internal/ofetch-transport'
import type { HttpSchema, SchemaOutput } from '../../schema'
import { StreamSession } from '../../stream/session'
import { forEach, takeUntil, use } from '../../stream/terminals'
import { NdjsonSession } from './session'
import type { NdjsonError, NdjsonOptions } from './parser'

export type HttpNdjsonRequestOptions<S extends HttpSchema | undefined = HttpSchema | undefined> =
  TransportRequestOptions & NdjsonOptions<S>

export type HttpNdjsonStream<S extends HttpSchema | undefined> =
  import('../../stream/description').HttpStream<
    S extends HttpSchema ? SchemaOutput<S> : unknown,
    NdjsonError,
    never
  >

const splitOptions = <S extends HttpSchema | undefined>(options: HttpNdjsonRequestOptions<S>) => {
  const { schema, limits, allowFinalRecordWithoutDelimiter, ...requestOptions } = options
  let parserOptions: NdjsonOptions<S> = {}
  if (schema !== undefined) parserOptions = { ...parserOptions, schema }
  if (limits !== undefined) parserOptions = { ...parserOptions, limits }
  if (allowFinalRecordWithoutDelimiter !== undefined)
    parserOptions = { ...parserOptions, allowFinalRecordWithoutDelimiter }
  return { requestOptions, parserOptions }
}

export const ndjson = <S extends HttpSchema | undefined = undefined>(
  config: TransportOptions,
  path: string,
  options: HttpNdjsonRequestOptions<S> = {} as HttpNdjsonRequestOptions<S>
): HttpNdjsonStream<S> => {
  const { requestOptions, parserOptions } = splitOptions(options)
  const request = Object.freeze({ method: 'GET', path, options: { ...requestOptions } })
  const open = async () =>
    new NdjsonSession(
      await StreamSession.make(await executeRequest(config, request)),
      parserOptions
    )
  return Object.freeze({
    request,
    results: async function* () {
      yield* (await open()).results()
    },
    use: (
      callback: (session: {
        readonly body: ReadableStream<unknown>
        readonly cancel: () => Promise<void>
      }) => unknown
    ) =>
      (async function* () {
        return yield* use(await open(), callback)
      })(),
    forEach: (callback: (value: unknown, index: number) => unknown) =>
      (async function* () {
        return yield* forEach(await open(), callback)
      })(),
    takeUntil: (
      predicate: (value: unknown) => boolean | Promise<boolean>,
      opts?: { readonly requireMatch?: boolean }
    ) =>
      (async function* () {
        return yield* takeUntil(await open(), predicate, opts)
      })()
  }) as unknown as HttpNdjsonStream<S>
}
