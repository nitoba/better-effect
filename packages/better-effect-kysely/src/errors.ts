import { TaggedError } from 'better-result'

/** A Kysely boundary that can produce a typed query failure. */
export type KyselyQueryOperation = 'execute' | 'executeTakeFirst' | 'executeQuery'

type KyselyQueryErrorProps = {
  readonly operation: KyselyQueryOperation
  readonly message: string
}

type KyselyQueryErrorJson = {
  readonly _tag: 'KyselyQueryError'
  readonly name: 'KyselyQueryError'
  readonly message: string
  readonly operation: KyselyQueryOperation
}

type KyselyTransactionErrorProps = {
  readonly message: string
}

type KyselyTransactionErrorJson = {
  readonly _tag: 'KyselyTransactionError'
  readonly name: 'KyselyTransactionError'
  readonly message: string
}

const queryFailureMessage = 'Kysely query execution failed.'
const transactionFailureMessage = 'Kysely transaction failed.'
const inspectCustom = Symbol.for('nodejs.util.inspect.custom')

const isKyselyQueryOperation = (value: string): value is KyselyQueryOperation =>
  value === 'execute' || value === 'executeTakeFirst' || value === 'executeQuery'

/**
 * A safe typed failure for a rejected or thrown Kysely query boundary.
 *
 * The original cause remains available in memory but is deliberately hidden
 * from ordinary enumeration and JSON serialization.
 */
export class KyselyQueryError extends TaggedError('KyselyQueryError')<KyselyQueryErrorProps> {
  declare readonly cause: unknown

  constructor(args: { readonly operation: KyselyQueryOperation; readonly cause: unknown }) {
    if (!isKyselyQueryOperation(args.operation)) {
      throw new TypeError(`Unsupported Kysely query operation: ${String(args.operation)}`)
    }

    super({ message: queryFailureMessage, operation: args.operation })

    Object.defineProperties(this, {
      cause: {
        configurable: false,
        enumerable: false,
        value: args.cause,
        writable: false
      },
      [inspectCustom]: {
        configurable: false,
        enumerable: false,
        value: () => this.toJSON(),
        writable: false
      }
    })
  }

  /** Serialize only low-sensitivity query metadata. */
  override toJSON(): KyselyQueryErrorJson {
    return {
      _tag: this._tag,
      message: this.message,
      name: 'KyselyQueryError',
      operation: this.operation
    }
  }
}

/**
 * A safe typed failure for a native Kysely transaction boundary failure.
 *
 * `bodyFailure` is retained only when a typed body failure was observed before
 * the native transaction or rollback failure replaced the private sentinel.
 */
export class KyselyTransactionError extends TaggedError(
  'KyselyTransactionError'
)<KyselyTransactionErrorProps> {
  declare readonly cause: unknown
  declare readonly bodyFailure?: unknown

  constructor(args: { readonly cause: unknown; readonly bodyFailure?: unknown }) {
    super({ message: transactionFailureMessage })

    Object.defineProperties(this, {
      cause: {
        configurable: false,
        enumerable: false,
        value: args.cause,
        writable: false
      },
      [inspectCustom]: {
        configurable: false,
        enumerable: false,
        value: () => this.toJSON(),
        writable: false
      }
    })

    if (Object.hasOwn(args, 'bodyFailure')) {
      Object.defineProperty(this, 'bodyFailure', {
        configurable: false,
        enumerable: false,
        value: args.bodyFailure,
        writable: false
      })
    }
  }

  /** Serialize only the stable transaction failure envelope. */
  override toJSON(): KyselyTransactionErrorJson {
    return {
      _tag: this._tag,
      message: this.message,
      name: 'KyselyTransactionError'
    }
  }
}
