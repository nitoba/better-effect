// oxlint-disable anti-slop/no-runtime-typeof -- Flow constructors validate untyped descriptor boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- Flow constructors accept user-provided DTOs.
// oxlint-disable anti-slop/no-chained-type-assertions -- immutable generic snapshots are narrowed after validation.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- metadata is normalized by the existing Job boundary.
// oxlint-disable anti-slop/no-known-value-widening -- generic descriptor snapshots preserve validated input types.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- casts restore generic types after runtime validation.

import { Result } from 'better-result'

import { readObjectFields } from './internal/json'
import { normalizeMetadata, Job, type AnyJobDefinition } from './job'
import {
  defaultFlowMaxChildren,
  defaultFlowMaxDepth,
  hardFlowMaxChildren,
  maxFlowChildKeyLength,
  maxFlowNameLength,
  validateFlowLimits
} from './protocol'
import { JobDefinitionError } from './protocol'
import { normalizeRetryPolicy, type RetryPolicy } from './retry'
import {
  validatePositiveIntegerValue,
  validatePriorityValue,
  validateTextValue
} from './internal/validation'
export type FlowChildOptions = {
  readonly priority?: number
  readonly attempts?: number
  readonly backoff?: RetryPolicy
  readonly timeoutMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

export type FlowChildInput<Payload> = {
  readonly key: string
  readonly payload: Payload
  readonly options?: FlowChildOptions
}

export interface FlowChildGroup<
  Definition extends AnyJobDefinition,
  Items extends readonly FlowChildInput<Job.PayloadInput<Definition>>[] = readonly FlowChildInput<
    Job.PayloadInput<Definition>
  >[]
> {
  readonly job: Definition
  readonly items: Items
}

export type FlowFailurePolicy = 'continue' | 'fail'

export interface FlowDefinition<
  Parent extends AnyJobDefinition,
  Children extends readonly AnyJobDefinition[],
  Policy extends FlowFailurePolicy = FlowFailurePolicy
> {
  readonly name: string
  readonly parent: Parent
  readonly children: Children
  readonly onChildFailure: Policy
  readonly maxChildren: number
  readonly maxDepth: number
}

export type AnyFlowDefinition = FlowDefinition<AnyJobDefinition, readonly AnyJobDefinition[]>

export type FlowDefinitionOptions<
  Parent extends AnyJobDefinition,
  Children extends readonly AnyJobDefinition[],
  Policy extends FlowFailurePolicy = FlowFailurePolicy
> = {
  readonly parent: Parent
  readonly children: Children
  readonly onChildFailure: Policy
  readonly maxChildren?: number
  readonly maxDepth?: number
}

const flowTypeId = Symbol.for('better-effect-mq/Flow')
const definitionFields = [
  'parent',
  'children',
  'onChildFailure',
  'maxChildren',
  'maxDepth'
] as const
const childFields = ['key', 'payload', 'options'] as const
const optionFields = ['priority', 'attempts', 'backoff', 'timeoutMs', 'metadata'] as const

const invalid = <Value>(field: string, message: string): Result<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const requireField = (
  fields: Readonly<Record<string, unknown>>,
  field: string
): Result<unknown, JobDefinitionError> =>
  Object.prototype.hasOwnProperty.call(fields, field)
    ? Result.ok(fields[field])
    : invalid(field, 'is required')

const identityKey = (definition: AnyJobDefinition): string =>
  JSON.stringify([definition.queue, definition.name, definition.version])

const validateFlowName = (value: unknown): Result<string, JobDefinitionError> => {
  const name = validateTextValue(value, 'name')
  if (Result.isError(name)) return name
  return name.value.length <= maxFlowNameLength
    ? name
    : invalid('name', `must not exceed ${maxFlowNameLength} characters`)
}

const validateOptions = (
  value: unknown
): Result<FlowChildOptions | undefined, JobDefinitionError> => {
  if (value === undefined) return Result.ok(undefined)
  const fields = readObjectFields(value, optionFields, 'options')
  if (Result.isError(fields)) return fields

  const priority =
    fields.value.priority === undefined
      ? Result.ok<number | undefined>(undefined)
      : validatePriorityValue(fields.value.priority, 'options.priority')
  const attempts =
    fields.value.attempts === undefined
      ? Result.ok<number | undefined>(undefined)
      : validatePositiveIntegerValue(fields.value.attempts, 'options.attempts')
  const backoff =
    fields.value.backoff === undefined
      ? Result.ok<RetryPolicy | undefined>(undefined)
      : normalizeRetryPolicy(fields.value.backoff)
  const timeoutMs =
    fields.value.timeoutMs === undefined
      ? Result.ok<number | undefined>(undefined)
      : validatePositiveIntegerValue(fields.value.timeoutMs, 'options.timeoutMs')
  const metadata =
    fields.value.metadata === undefined
      ? Result.ok<Readonly<Record<string, string>> | undefined>(undefined)
      : normalizeMetadata(fields.value.metadata)
  if (Result.isError(priority)) return priority
  if (Result.isError(attempts)) return attempts
  if (Result.isError(backoff)) return backoff
  if (Result.isError(timeoutMs)) return timeoutMs
  if (Result.isError(metadata)) return metadata

  const options: FlowChildOptions = {}
  if (priority.value !== undefined) Object.assign(options, { priority: priority.value })
  if (attempts.value !== undefined) Object.assign(options, { attempts: attempts.value })
  if (backoff.value !== undefined) Object.assign(options, { backoff: backoff.value })
  if (timeoutMs.value !== undefined) Object.assign(options, { timeoutMs: timeoutMs.value })
  if (metadata.value !== undefined) Object.assign(options, { metadata: metadata.value })

  return Result.ok(Object.freeze(options))
}

const validateChildItems = <Payload>(
  value: unknown
): Result<readonly FlowChildInput<Payload>[], JobDefinitionError> => {
  if (!Array.isArray(value)) return invalid('items', 'must be a finite array')
  if (value.length > hardFlowMaxChildren) {
    return invalid('items', `must not exceed hard limit ${hardFlowMaxChildren}`)
  }

  const items: FlowChildInput<Payload>[] = []
  const keys = new Set<string>()
  for (const [index, itemValue] of value.entries()) {
    const fields = readObjectFields(itemValue, childFields, `items[${index}]`)
    if (Result.isError(fields)) return fields
    const key = requireField(fields.value, 'key')
    const payload = requireField(fields.value, 'payload')
    if (Result.isError(key)) return invalid(`items[${index}].key`, key.error.message)
    if (Result.isError(payload)) return invalid(`items[${index}].payload`, payload.error.message)
    const checkedKey = validateTextValue(key.value, `items[${index}].key`)
    if (Result.isError(checkedKey)) return checkedKey
    if (checkedKey.value.length > maxFlowChildKeyLength) {
      return invalid(`items[${index}].key`, `must not exceed ${maxFlowChildKeyLength} characters`)
    }
    if (keys.has(checkedKey.value)) {
      return invalid('items', `duplicate childKey "${checkedKey.value}"`)
    }
    keys.add(checkedKey.value)
    const options = validateOptions(fields.value.options)
    if (Result.isError(options)) return invalid(`items[${index}].options`, options.error.message)
    const item: { key: string; payload: Payload; options?: FlowChildOptions } = {
      key: checkedKey.value,
      payload: payload.value as Payload
    }
    if (options.value !== undefined) {
      item.options = options.value
    }
    items.push(Object.freeze(item))
  }

  return Result.ok(Object.freeze(items))
}

const buildFlow = <
  Parent extends AnyJobDefinition,
  Children extends readonly AnyJobDefinition[],
  Policy extends FlowFailurePolicy
>(
  name: string,
  options: FlowDefinitionOptions<Parent, Children, Policy>
): FlowDefinition<Parent, Children, Policy> => {
  const flowName = validateFlowName(name)
  if (Result.isError(flowName)) throw flowName.error
  const fields = readObjectFields(options, definitionFields, 'options')
  if (Result.isError(fields)) throw fields.error

  for (const field of ['parent', 'children', 'onChildFailure'] as const) {
    const present = requireField(fields.value, field)
    if (Result.isError(present)) throw present.error
  }
  if (!Job.is(fields.value.parent)) {
    throw new JobDefinitionError({ field: 'parent', message: 'must be a Job definition' })
  }
  if (!Array.isArray(fields.value.children)) {
    throw new JobDefinitionError({ field: 'children', message: 'must be a finite array' })
  }
  const policy = fields.value.onChildFailure
  if (policy !== 'continue' && policy !== 'fail') {
    throw new JobDefinitionError({ field: 'onChildFailure', message: 'must be continue or fail' })
  }
  const failurePolicy = policy as Policy

  const children: AnyJobDefinition[] = []
  const identities = new Set<string>()
  for (const [index, child] of fields.value.children.entries()) {
    if (!Job.is(child)) {
      throw new JobDefinitionError({
        field: `children[${index}]`,
        message: 'must be a Job definition'
      })
    }
    const identity = identityKey(child)
    if (identities.has(identity)) {
      throw new JobDefinitionError({ field: 'children', message: 'duplicate child Job identity' })
    }
    identities.add(identity)
    children.push(child)
  }

  const limits = validateFlowLimits({
    maxChildren: fields.value.maxChildren ?? defaultFlowMaxChildren,
    maxDepth: fields.value.maxDepth ?? defaultFlowMaxDepth
  })
  if (Result.isError(limits)) throw limits.error

  return Object.freeze({
    [flowTypeId]: true,
    name: flowName.value,
    parent: fields.value.parent as Parent,
    children: Object.freeze(children) as Children,
    onChildFailure: failurePolicy,
    maxChildren: limits.value.maxChildren,
    maxDepth: limits.value.maxDepth
  }) as FlowDefinition<Parent, Children, Policy>
}

const makeChildren = <
  Definition extends AnyJobDefinition,
  Items extends readonly FlowChildInput<Job.PayloadInput<Definition>>[]
>(
  job: Definition,
  items: Items
): FlowChildGroup<Definition, Items> => {
  if (!Job.is(job)) {
    throw new JobDefinitionError({ field: 'job', message: 'must be a Job definition' })
  }
  const checked = validateChildItems<Job.PayloadInput<Definition>>(items)
  if (Result.isError(checked)) throw checked.error

  return Object.freeze({
    job,
    items: checked.value as Items
  }) as FlowChildGroup<Definition, Items>
}

export const Flow = Object.freeze({
  TypeId: flowTypeId,
  is(value: unknown): value is AnyFlowDefinition {
    if (typeof value !== 'object' || value === null) return false
    try {
      return flowTypeId in value
    } catch {
      return false
    }
  },
  define: buildFlow,
  children: makeChildren
})

export type FlowParent<Current extends AnyFlowDefinition> = Current['parent']
export type FlowChildren<Current extends AnyFlowDefinition> = Current['children']
export type FlowChildDefinition<Current extends AnyFlowDefinition> = FlowChildren<Current>[number]
export type FlowName<Current extends AnyFlowDefinition> = Current['name']
