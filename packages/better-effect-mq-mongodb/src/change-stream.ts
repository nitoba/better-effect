import type { MongoChangeStream, MongoDb } from './config'

/** Advisory queue wake source. Durable queue wakeVersion polling remains authoritative. */
export class MongoQueueChangeStream {
  private stream: MongoChangeStream | undefined
  constructor(
    private readonly db: MongoDb,
    private readonly namespace: string,
    private readonly onWake: () => void
  ) {}
  start(): boolean {
    try {
      if (this.db.watch === undefined) return false
      this.stream = this.db.watch([{ $match: { 'fullDocument.namespace': this.namespace } }], {
        fullDocument: 'updateLookup'
      })
      this.stream.on('change', () => this.onWake())
      this.stream.on('error', () => this.onWake())
      return true
    } catch {
      return false
    }
  }
  async close(): Promise<void> {
    await this.stream?.close()
    this.stream = undefined
  }
}
