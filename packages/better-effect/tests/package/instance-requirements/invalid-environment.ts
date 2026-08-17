import type { Effect } from 'better-effect'

interface RandomEnvironment {
  readonly random: true
}

export type InvalidEmptyEnvironment = Effect<string, Error, {}>
export type InvalidObjectEnvironment = Effect<string, Error, object>
export type InvalidUnknownEnvironment = Effect<string, Error, unknown>
export type InvalidRandomEnvironment = Effect<string, Error, RandomEnvironment>
export type InvalidPrimitiveEnvironment = Effect<string, Error, string>
