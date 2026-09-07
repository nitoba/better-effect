import type { StandardSchemaV1 } from '@standard-schema/spec'
import { Result } from 'better-result'

import { SchemaDefinitionFailure } from '../failure.js'
import { invokeAsync, invokeSync, type AsyncExecution, type SyncExecution } from './execution.js'
import { schemaSuccess } from './result.js'

export type StandardSchema = StandardSchemaV1

export type StandardValidation<Output> =
  | { readonly _tag: 'success'; readonly value: Output }
  | { readonly _tag: 'failure'; readonly issues: unknown }
  | { readonly _tag: 'definition'; readonly failure: SchemaDefinitionFailure }

const isObjectLike = (value: unknown): value is object | Function =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const definitionFailure = (
  identifier: string,
  operation: string,
  cause: unknown
): SchemaDefinitionFailure => new SchemaDefinitionFailure({ identifier, operation, cause })

const definition = (
  identifier: string,
  operation: string,
  cause: unknown
): StandardValidation<never> => ({
  _tag: 'definition',
  failure: definitionFailure(identifier, operation, cause)
})

type ReadPropsResult =
  | { readonly valid: true; readonly props: StandardSchemaV1.Props }
  | { readonly valid: false; readonly failure: SchemaDefinitionFailure }

const normalizeResult = <Output>(
  result: unknown,
  identifier: string,
  operation: string
): StandardValidation<Output> => {
  if (!isObjectLike(result)) return definition(identifier, operation, 'invalid-result')

  const issues = Reflect.get(result, 'issues')
  if (issues !== undefined) {
    return Array.isArray(issues)
      ? { _tag: 'failure', issues }
      : definition(identifier, operation, 'invalid-issues')
  }

  if (!Reflect.has(result, 'value')) return definition(identifier, operation, 'missing-value')
  return { _tag: 'success', value: Reflect.get(result, 'value') as Output }
}

const readProps = (
  schema: StandardSchema,
  identifier: string,
  operation: string
): ReadPropsResult => {
  const standard = Reflect.get(schema, '~standard')
  if (!isObjectLike(standard)) {
    return {
      valid: false,
      failure: definitionFailure(identifier, operation, 'missing-standard')
    }
  }

  const version = Reflect.get(standard, 'version')
  const vendor = Reflect.get(standard, 'vendor')
  const validate = Reflect.get(standard, 'validate')
  if (version !== 1 || typeof vendor !== 'string' || typeof validate !== 'function') {
    return {
      valid: false,
      failure: definitionFailure(identifier, operation, 'invalid-standard')
    }
  }

  return { valid: true, props: standard as StandardSchemaV1.Props }
}

/** Consume one Standard Schema validation without inspecting provider-specific internals. */
export const validateStandardSync = <Output>(
  schema: StandardSchema,
  value: unknown,
  identifier: string,
  operation: string,
  options: StandardSchemaV1.Options | undefined
): SyncExecution<StandardValidation<Output>> =>
  (() => {
    const propsResult = invokeSync<ReadPropsResult>(operation, () =>
      readProps(schema, identifier, operation)
    )
    if (Result.isError(propsResult)) {
      return propsResult as unknown as SyncExecution<StandardValidation<Output>>
    }
    const props = propsResult.value
    if (!props.valid) {
      return schemaSuccess<StandardValidation<Output>, never>({
        _tag: 'definition',
        failure: props.failure
      }) as SyncExecution<StandardValidation<Output>>
    }

    const validationResult = invokeSync<unknown>(operation, () =>
      options === undefined
        ? props.props.validate.call(props.props, value)
        : props.props.validate.call(props.props, value, options)
    )
    if (Result.isError(validationResult)) {
      return validationResult as SyncExecution<StandardValidation<Output>>
    }

    const normalized = invokeSync<StandardValidation<Output>>(operation, () =>
      normalizeResult<Output>(validationResult.value, identifier, operation)
    )
    return normalized as SyncExecution<StandardValidation<Output>>
  })()

/** Consume one Standard Schema validation and await its result exactly once. */
export const validateStandardAsync = async <Output>(
  schema: StandardSchema,
  value: unknown,
  identifier: string,
  operation: string,
  options: StandardSchemaV1.Options | undefined
): Promise<AsyncExecution<StandardValidation<Output>>> =>
  (async () => {
    const propsResult = invokeSync<ReadPropsResult>(operation, () =>
      readProps(schema, identifier, operation)
    )
    if (Result.isError(propsResult)) {
      return propsResult as unknown as AsyncExecution<StandardValidation<Output>>
    }
    const props = propsResult.value
    if (!props.valid) {
      return schemaSuccess<StandardValidation<Output>, never>({
        _tag: 'definition',
        failure: props.failure
      }) as AsyncExecution<StandardValidation<Output>>
    }

    const validationResult = await invokeAsync<unknown>(operation, () =>
      options === undefined
        ? props.props.validate.call(props.props, value)
        : props.props.validate.call(props.props, value, options)
    )
    if (Result.isError(validationResult)) {
      return validationResult as AsyncExecution<StandardValidation<Output>>
    }

    const normalized = invokeSync<StandardValidation<Output>>(operation, () =>
      normalizeResult<Output>(validationResult.value, identifier, operation)
    )
    return normalized as AsyncExecution<StandardValidation<Output>>
  })()
