/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof -- the recipe server intentionally validates unknown wire payloads with small provider-neutral helpers at the I/O boundary. */
import type { StandardSchemaV1 } from 'better-effect-schema'

export type JsonObject = Readonly<Record<string, unknown>>

/** A tiny provider-neutral schema used by the examples. */
export const schema = <Output>(
  decode: (value: unknown) => Output | undefined,
  name = 'better-effect-http-example'
): StandardSchemaV1<unknown, Output> => ({
  '~standard': {
    version: 1,
    vendor: name,
    types: undefined as unknown as StandardSchemaV1.Types<unknown, Output>,
    validate(value) {
      const output = decode(value)
      return output === undefined
        ? { issues: [{ message: 'Invalid example value' }] }
        : { value: output }
    }
  }
})

export const object = (value: unknown): JsonObject | undefined =>
  typeof value === 'object' && value !== null ? (value as JsonObject) : undefined

export const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const boolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined

/** Run a controlled local HTTP server and always stop its listener. */
export const withLocalServer = async <A>(
  handler: (request: Request) => Response | Promise<Response>,
  use: (baseURL: string) => Promise<A>
): Promise<A> => {
  const server = Bun.serve({ port: 0, fetch: handler })
  try {
    return await use(`http://127.0.0.1:${server.port}`)
  } finally {
    await server.stop(true)
  }
}

export const streamResponse = (
  chunks: readonly string[],
  headers: Record<string, string>
): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { status: 200, headers }
  )
