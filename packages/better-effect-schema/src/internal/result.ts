import { Result } from "better-result"
import type { SchemaEffect } from "../schema-effect.js"

export const schemaSuccess = <Value, Failure>(
  value: Value
): SchemaEffect<Value, Failure> =>
  Result.ok(value) as SchemaEffect<Value, Failure>

export const schemaFailure = <Value, Failure>(
  failure: Failure
): SchemaEffect<Value, Failure> =>
  Result.err(failure) as SchemaEffect<Value, Failure>
