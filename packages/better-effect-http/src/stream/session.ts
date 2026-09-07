import { Scope } from 'better-effect'
import { Result } from 'better-result'
import { HttpStreamBodyError, HttpStreamConsumedError, HttpStreamReadError } from './errors'

export type StreamMetadata = Readonly<{
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly url: string
}>

export type StreamChunk =
  | Readonly<{ readonly done: false; readonly value: Uint8Array }>
  | Readonly<{ readonly done: true }>

/** A one-shot, scoped reader. Reading is pull based: no work starts until read() is called. */
export class StreamSession {
  readonly metadata: StreamMetadata
  private readonly scope
  private readonly body: ReadableStream<Uint8Array> | null
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private closed = false
  private reading = false
  private bytesRead = 0

  get bodyStream(): ReadableStream<Uint8Array> {
    if (this.closed) throw new HttpStreamConsumedError({ phase: 'read' })
    return this.body ?? new ReadableStream<Uint8Array>()
  }

  private constructor(response: Response, scope: ReturnType<Scope['fork']>) {
    this.metadata = Object.freeze({
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
      url: response.url
    })
    this.scope = scope
    // SAFETY: stream descriptions request Uint8Array bodies at the transport boundary.
    this.body = response.body
    scope.addFinalizer(async () => {
      this.closed = true
      try {
        if (this.reader) await this.reader.cancel()
        else await this.body?.cancel()
      } finally {
        this.reader?.releaseLock()
      }
    })
  }

  static async make(response: Response): Promise<StreamSession> {
    const parent = Scope.current()
    const child = parent.fork()
    try {
      if (!response.ok) {
        await response.body?.cancel()
        await child.close({ status: 'success' })
        throw new HttpStreamBodyError({ phase: 'body', status: response.status })
      }
      return new StreamSession(response, child)
    } catch (cause) {
      await child.close({ status: 'failure', cause }).catch(() => undefined)
      throw cause
    }
  }

  async read(): Promise<StreamChunk> {
    if (this.closed) throw new HttpStreamConsumedError({ phase: 'read' })
    if (this.reading) throw new HttpStreamConsumedError({ phase: 'read' })
    this.reading = true
    try {
      if (!this.reader) {
        // SAFETY: a stream body exposes the standard Uint8Array reader contract.
        this.reader = this.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined
      }
      if (!this.reader) return await this.finish()
      const result = await this.reader.read()
      if (result.done) return await this.finish()
      const value = new Uint8Array(result.value)
      this.bytesRead += value.byteLength
      return { done: false, value }
    } catch (cause) {
      this.closed = true
      await this.scope.close({ status: 'failure', cause }).catch(() => undefined)
      throw new HttpStreamReadError({ phase: 'read', cause, bytesRead: this.bytesRead })
    } finally {
      this.reading = false
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.scope.close({ status: 'success' })
  }

  /** Lazily exposes chunks as Results; a read failure is emitted once before EOF. */
  async *results(): AsyncIterable<Result<Uint8Array, HttpStreamReadError>> {
    try {
      while (true) {
        const chunk = await this.read()
        if (chunk.done) return
        yield Result.ok(chunk.value)
      }
    } catch (cause) {
      if (cause instanceof HttpStreamReadError) yield Result.err(cause)
      else throw cause
    } finally {
      await this.close().catch(() => undefined)
    }
  }

  private async finish(): Promise<StreamChunk> {
    this.closed = true
    await this.scope.close({ status: 'success' })
    return { done: true }
  }
}
