import { expect } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'
import type { StandardSchemaV1 } from '@standard-schema/spec'

export type StandardIssue = {
  readonly message: string
  readonly path?: readonly unknown[]
}

export type StandardValidation<Output> =
  | { readonly value: Output }
  | { readonly issues: readonly StandardIssue[] }

export const standardSchema = <Input, Output>(
  validate: (
    value: unknown,
    options?: StandardSchemaV1.Options
  ) => StandardValidation<Output> | PromiseLike<StandardValidation<Output>>,
  vendor = 'better-effect-schema-conformance'
): StandardSchemaV1<Input, Output> =>
  ({
    '~standard': {
      version: 1,
      vendor,
      validate
    }
  }) as StandardSchemaV1<Input, Output>

export const standardIssue = (message: string, path?: StandardIssue['path']): StandardIssue => ({
  message,
  ...(path === undefined ? {} : { path })
})

export const unwrapOk = <Value, Failure>(result: ResultType<Value, Failure>): Value => {
  if (Result.isError(result)) {
    throw new Error(`Expected Result.ok, received ${String(result.error)}`)
  }
  return result.value
}

export const unwrapErr = <Value, Failure>(result: ResultType<Value, Failure>): Failure => {
  if (Result.isOk(result)) {
    throw new Error('Expected Result.err, received Result.ok')
  }
  return result.error
}

export const expectFailure = <Value, Failure>(
  result: ResultType<Value, Failure>,
  failure: abstract new (...args: never[]) => Failure
): Failure => {
  const error = unwrapErr(result)
  expect(error).toBeInstanceOf(failure)
  return error
}

export const noThrowSync = <Value>(run: () => Value): Value => {
  let value!: Value
  expect(() => {
    value = run()
  }).not.toThrow()
  return value
}

export const noThrowAsync = async <Value>(
  run: () => Value | PromiseLike<Value>
): Promise<Value> => {
  let value!: Value
  let thrown: unknown
  try {
    value = await run()
  } catch (cause) {
    thrown = cause
  }
  expect(thrown).toBeUndefined()
  return value
}
