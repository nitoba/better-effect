import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import { sanitizeSchemaIssues } from '../internal/issues.js'

const STANDARD_VENDOR = 'better-effect-schema'

type StandardResult = StandardSchemaV1.Result<object>

interface GenericRuntimeClass {
  readonly schema: StandardSchemaV1
  makeAsync(value: unknown): PromiseLike<unknown>
}

export interface StandardBridge {
  readonly validate: StandardSchemaV1.Props<unknown, object>['validate']
  readonly validateSync?: StandardSchemaV1.Props<unknown, object>['validate']
}

export type StandardBridgeFactory = (constructor: Function) => StandardBridge

const failure = (cause: unknown): StandardSchemaV1.FailureResult => {
  try {
    return { issues: sanitizeSchemaIssues(cause) }
  } catch {
    return { issues: [{ message: 'Validation failed' }] }
  }
}

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const normalizeResult = (result: unknown): StandardResult => {
  try {
    if (!isObjectLike(result)) return failure('invalid-result')

    const issues = Reflect.get(result, 'issues')
    if (issues !== undefined) {
      return Array.isArray(issues)
        ? { issues: sanitizeSchemaIssues(issues) }
        : failure('invalid-issues')
    }

    if (!Reflect.has(result, 'value')) return failure('missing-value')
    return { value: Reflect.get(result, 'value') as object }
  } catch (cause) {
    return failure(cause)
  }
}

const normalizeOperationResult = (result: unknown): StandardResult => {
  try {
    if (Result.isError(result as never)) {
      return failure(Reflect.get(result as object, 'error'))
    }
    if (!isObjectLike(result) || !Reflect.has(result, 'value')) return failure('invalid-result')
    return { value: Reflect.get(result, 'value') as object }
  } catch (cause) {
    return failure(cause)
  }
}

const validateCapability = (
  schema: StandardSchemaV1,
  value: unknown,
  options: StandardSchemaV1.Options | undefined
): unknown => {
  const standard = Reflect.get(schema, '~standard')
  if (!isObjectLike(standard)) return { issues: [{ message: 'Validation failed' }] }

  const validate = Reflect.get(standard, 'validate')
  if (typeof validate !== 'function') return { issues: [{ message: 'Validation failed' }] }

  return options === undefined
    ? Reflect.apply(validate, standard, [value])
    : Reflect.apply(validate, standard, [value, options])
}

const validateGeneric = async (
  constructor: Function,
  value: unknown,
  options: StandardSchemaV1.Options | undefined
): Promise<StandardResult> => {
  try {
    const runtime = constructor as unknown as GenericRuntimeClass
    const decoded = normalizeResult(await validateCapability(runtime.schema, value, options))
    if ('issues' in decoded) return decoded

    return normalizeOperationResult(await runtime.makeAsync(decoded.value))
  } catch (cause) {
    return failure(cause)
  }
}

/** Create the bridge for the provider-neutral class runtime. */
export const genericBridgeFor: StandardBridgeFactory = (constructor) => ({
  validate: (value: unknown, options?: StandardSchemaV1.Options): Promise<StandardResult> =>
    validateGeneric(constructor, value, options)
})

const standardFor = (
  constructor: Function,
  createBridge: StandardBridgeFactory
): StandardSchemaV1.Props<unknown, object> => {
  const bridge = createBridge(constructor)
  const standard: StandardSchemaV1.Props<unknown, object> = {
    version: 1 as const,
    vendor: STANDARD_VENDOR,
    validate: bridge.validate
  }

  if (bridge.validateSync !== undefined) {
    Object.defineProperty(standard, 'validateSync', {
      configurable: false,
      enumerable: false,
      value: bridge.validateSync,
      writable: false
    })
  }

  return Object.freeze(standard)
}

/** Convert an internal Result-like operation to the Standard Schema result shape. */
export const standardResultFromOperation = (result: unknown): StandardResult =>
  normalizeOperationResult(result)

/** Convert an unexpected runtime failure to a safe Standard Schema failure. */
export const standardFailure = (cause: unknown): StandardSchemaV1.FailureResult => failure(cause)

/** Install the provider-neutral Standard Schema bridge on a schema class. */
export const installStandardSchema = (
  constructor: Function,
  createBridge: StandardBridgeFactory
): void => {
  Object.defineProperty(constructor, '~standard', {
    configurable: true,
    enumerable: false,
    get(this: unknown): StandardSchemaV1.Props<unknown, object> {
      return standardFor(typeof this === 'function' ? this : constructor, createBridge)
    }
  })
}
