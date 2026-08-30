import type { APIError } from 'better-auth/api'
import { TaggedError } from 'better-result'

declare const BetterAuthRuntimeErrorCodeTypeId: unique symbol

/** A runtime Better Auth code that was not necessarily present in the configured `$ERROR_CODES`. */
export type BetterAuthRuntimeErrorCode = string & {
  readonly [BetterAuthRuntimeErrorCodeTypeId]: 'BetterAuthRuntimeErrorCode'
}

/** Safe serialized representation of a Better Auth API failure. */
export interface BetterAuthApiErrorJson<Code extends string = string> {
  readonly _tag: 'BetterAuthApiError'
  readonly name: 'BetterAuthApiError'
  readonly message: string
  readonly status: APIError['status']
  readonly statusCode: number
  readonly code: Code | BetterAuthRuntimeErrorCode | undefined
}

type BetterAuthApiErrorProps<Code extends string> = {
  readonly status: APIError['status']
  readonly statusCode: number
  readonly code: Code | BetterAuthRuntimeErrorCode | undefined
  readonly message: string
  readonly headers: APIError['headers']
  readonly body: APIError['body']
  readonly cause: APIError
}

type BetterAuthApiErrorCodeValue = NonNullable<APIError['body']>['code'] | undefined

const isStringCode = (code: BetterAuthApiErrorCodeValue): code is string =>
  Object.prototype.toString.call(code) === '[object String]'

const runtimeErrorCode = (code: string): BetterAuthRuntimeErrorCode =>
  // SAFETY: the brand is declaration-only and records that this string came from the runtime APIError body.
  code as BetterAuthRuntimeErrorCode

const readErrorCode = (error: APIError): BetterAuthRuntimeErrorCode | undefined => {
  const code = error.body?.code

  return isStringCode(code) ? runtimeErrorCode(code) : undefined
}

/**
 * A typed failure produced from Better Auth's public `APIError` boundary.
 *
 * The original body, headers, and cause remain available in memory, but are
 * deliberately excluded from enumeration and JSON serialization because they
 * can contain cookies, tokens, adapter details, or other sensitive values.
 */
export class BetterAuthApiError<Code extends string = string> extends TaggedError(
  'BetterAuthApiError'
)<BetterAuthApiErrorProps<Code>> {
  constructor(args: BetterAuthApiErrorProps<Code>) {
    super(args)

    Object.defineProperties(this, {
      body: { enumerable: false },
      cause: { enumerable: false },
      headers: { enumerable: false }
    })
  }

  /** Create a typed integration failure without mutating the source `APIError`. */
  static from<Code extends string = string>(error: APIError): BetterAuthApiError<Code> {
    return new BetterAuthApiError<Code>({
      body: error.body,
      cause: error,
      code: readErrorCode(error),
      headers: error.headers,
      message: error.message,
      status: error.status,
      statusCode: error.statusCode
    })
  }

  /** Serialize only low-sensitivity diagnostic fields. */
  override toJSON(): BetterAuthApiErrorJson<Code> {
    return {
      _tag: this._tag,
      code: this.code,
      message: this.message,
      name: 'BetterAuthApiError',
      status: this.status,
      statusCode: this.statusCode
    }
  }
}

/** Failure returned only when an explicitly required session is absent. */
export class Unauthenticated extends TaggedError('Unauthenticated')<{
  readonly message: string
}> {}
