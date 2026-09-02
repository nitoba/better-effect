import type { Effect } from "better-effect"

/** A requirement-free better-effect value backed by a better-result Result. */
export type SchemaEffect<Value, Failure> = Effect<Value, Failure, never>
