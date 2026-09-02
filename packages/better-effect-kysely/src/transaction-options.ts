import type { AccessMode, IsolationLevel } from 'kysely'

/** Native settings accepted by Kysely's callback transaction builder. */
export interface KyselyTransactionOptions {
  readonly isolationLevel?: IsolationLevel
  readonly accessMode?: AccessMode
}
