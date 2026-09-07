/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- the NDJSON description erases one heterogeneous schema boundary after validating options. */
import { executeRequest } from '../../internal/ofetch-transport'
import type { TransportOptions, TransportRequestOptions } from '../../internal/ofetch-transport'
import type { HttpSchema, SchemaOutput } from '../../schema'
import { StreamSession } from '../../stream/session'
import { forEach, takeUntil, use } from '../../stream/terminals'
import { NdjsonSession } from './session'
import type { NdjsonError, NdjsonOptions } from './parser'
import type { HttpAdmission } from '../../limits'

type NdjsonLimiter = Readonly<{
  readonly admit: (signal?: AbortSignal) => Promise<HttpAdmission>
}>

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
  options: HttpNdjsonRequestOptions<S> = {} as HttpNdjsonRequestOptions<S>,
  limiter?: NdjsonLimiter
): HttpNdjsonStream<S> => {
  const { requestOptions, parserOptions } = splitOptions(options)
  const request = Object.freeze({ method: 'GET', path, options: { ...requestOptions } })
  const open = async () => {
    const admission = limiter === undefined ? undefined : await limiter.admit(options.signal)
    try {
      return {
        session: new NdjsonSession(
          await StreamSession.make(await executeRequest(config, request)),
          parserOptions
        ),
        admission
      }
    } catch (cause) {
      admission?.release()
      throw cause
    }
  }
  return Object.freeze({
    request,
    results: async function* () {
      const opened = await open()
      try {
        yield* opened.session.results()
      } finally {
        opened.admission?.release()
      }
    },
    use: (
      callback: (session: {
        readonly body: ReadableStream<unknown>
        readonly cancel: () => Promise<void>
      }) => unknown
    ) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* use(opened.session, callback)
        } finally {
          opened.admission?.release()
        }
      })(),
    forEach: (callback: (value: unknown, index: number) => unknown) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* forEach(opened.session, callback)
        } finally {
          opened.admission?.release()
        }
      })(),
    takeUntil: (
      predicate: (value: unknown) => boolean | Promise<boolean>,
      opts?: { readonly requireMatch?: boolean }
    ) =>
      (async function* () {
        const opened = await open()
        try {
          return yield* takeUntil(opened.session, predicate, opts)
        } finally {
          opened.admission?.release()
        }
      })()
  }) as unknown as HttpNdjsonStream<S>
}
