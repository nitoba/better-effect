import type { SqliteDatabase } from './config'

/** Small ownership wrapper used by host integrations and application scopes. */
export class SqliteClient {
  private closed = false
  constructor(
    readonly database: SqliteDatabase,
    readonly ownsDatabase = false
  ) {}
  close(): void {
    if (this.closed || !this.ownsDatabase) return
    this.closed = true
    this.database.close?.()
  }
}
