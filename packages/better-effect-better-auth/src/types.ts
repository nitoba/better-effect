import type { UnhandledException } from 'better-result'

import type { BetterAuthApiError } from './errors'

/** Public shape carried by values in Better Auth's `$ERROR_CODES` map. */
export interface BetterAuthErrorCodeValue {
  readonly code: string
  readonly message: string
}

/** Minimal Better Auth instance surface needed to infer configured error codes. */
export interface BetterAuthErrorCodeSource {
  readonly $ERROR_CODES: Readonly<Record<string, BetterAuthErrorCodeValue>>
}

/** Server-side Better Auth surface adapted by this package. */
export interface BetterAuthInstance extends BetterAuthErrorCodeSource {
  readonly api: {
    readonly getSession: (context: never) => PromiseLike<unknown>
  }
  readonly handler: (request: Request) => PromiseLike<Response>
  readonly $Infer: {
    readonly Session: unknown
  }
}

/** Error-code literals contributed by Better Auth core and configured plugins. */
export type BetterAuthErrorCode<Auth extends BetterAuthErrorCodeSource> = Extract<
  keyof Auth['$ERROR_CODES'],
  string
>

/** Failure channel shared by generic server-side Better Auth operations. */
export type BetterAuthFailure<Auth extends BetterAuthErrorCodeSource> =
  | BetterAuthApiError<BetterAuthErrorCode<Auth>>
  | UnhandledException
