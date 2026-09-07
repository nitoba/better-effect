import { Result } from 'better-result'
import type { HttpSchema } from '../../schema'
import { HttpStreamConsumedError } from '../../stream/errors'
import type { StreamMetadata } from '../../stream/session'
import { parseNdjson } from './parser'
import type { NdjsonError, NdjsonOptions, NdjsonOutput } from './parser'
import type { StreamSession } from '../../stream/session'

export class NdjsonSession<S extends HttpSchema | undefined> {
  readonly metadata: StreamMetadata
  private readonly source: StreamSession
  private readonly options: NdjsonOptions<S>
  private iterator: AsyncIterator<Result<NdjsonOutput<S>, NdjsonError>> | undefined
  private consumer: 'results' | 'body' | undefined
  private body: ReadableStream<NdjsonOutput<S>> | undefined
  private closed = false

  constructor(source: StreamSession, options: NdjsonOptions<S>) {
    this.source = source
    this.options = options
    this.metadata = source.metadata
  }

  get bodyStream(): ReadableStream<NdjsonOutput<S>> {
    if (this.closed) throw new HttpStreamConsumedError({ phase: 'read' })
    if (this.body) return this.body
    this.ensureConsumer('body')
    this.body = new ReadableStream<NdjsonOutput<S>>({
      pull: async (controller) => {
        try {
          const next = await this.next()
          if (next.done) {
            await this.close()
            controller.close()
          } else if (Result.isError(next.value)) {
            await this.close()
            controller.error(next.value.error)
          } else controller.enqueue(next.value.value)
        } catch (cause) {
          await this.close().catch(() => undefined)
          controller.error(cause)
        }
      },
      cancel: async () => {
        await this.close()
      }
    })
    return this.body
  }

  results(): AsyncIterable<Result<NdjsonOutput<S>, NdjsonError>> {
    if (this.consumer !== undefined) throw new HttpStreamConsumedError({ phase: 'read' })
    this.consumer = 'results'
    return this.iterate()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.iterator?.return?.()
    } finally {
      await this.source.close()
    }
  }

  private ensureConsumer(next: 'results' | 'body'): void {
    if (this.consumer !== undefined && this.consumer !== next)
      throw new HttpStreamConsumedError({ phase: 'read' })
    this.consumer = next
  }

  private ensureIterator(): AsyncIterator<Result<NdjsonOutput<S>, NdjsonError>> {
    if (this.iterator === undefined)
      this.iterator = parseNdjson(this.source, this.options)[Symbol.asyncIterator]()
    return this.iterator
  }

  private async next(): Promise<IteratorResult<Result<NdjsonOutput<S>, NdjsonError>>> {
    if (this.closed) {
      // SAFETY: a completed iterator has no return payload; only its done flag is observed.
      return { done: true, value: undefined as never }
    }
    // SAFETY: the parser iterator is created by parseNdjson and always exposes the async iterator protocol.
    return await this.ensureIterator().next()
  }

  private async *iterate(): AsyncIterable<Result<NdjsonOutput<S>, NdjsonError>> {
    try {
      while (true) {
        const next = await this.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      await this.close().catch(() => undefined)
    }
  }
}
