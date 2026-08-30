// oxlint-disable anti-slop/no-runtime-typeof -- registry inputs and lookup identities are untrusted boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- registry guards accept arbitrary JavaScript values.
// oxlint-disable anti-slop/no-chained-type-assertions -- registry snapshots are erased after validation.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated snapshots justify these assertions.

import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError, makeJobName, makeQueueName } from '../protocol'

import { Job, type AnyJobDefinition, type JobIdentity } from './job'
import { isPlainObject, readOwnDataProperty } from './internal'

export type RegistryIdentityInput = JobIdentity<string, string, number>

/** An identity constrained to the registry's queue/name/version literals. */
export type RegisteredJobIdentity<
  Queue extends string = string,
  Name extends string = string,
  Version extends number = number
> = JobIdentity<Queue, Name, Version>

type RegistryMatch<
  Definitions extends readonly AnyJobDefinition[],
  Queue extends string,
  Name extends string,
  Version extends number
> = string extends Queue
  ? Definitions[number]
  : string extends Name
    ? Definitions[number]
    : number extends Version
      ? Definitions[number]
      : string extends Definitions[number]['queue']
        ? Definitions[number]
        : string extends Definitions[number]['name']
          ? Definitions[number]
          : number extends Definitions[number]['version']
            ? Definitions[number]
            : Extract<
                Definitions[number],
                { readonly queue: Queue; readonly name: Name; readonly version: Version }
              >

type AcceptedIdentities<Definitions extends readonly AnyJobDefinition[]> = {
  readonly [Index in keyof Definitions]: RegisteredJobIdentity<
    Job.Queue<Definitions[Index]>,
    Job.Name<Definitions[Index]>,
    Job.Version<Definitions[Index]>
  >
}

type RegistryLookup<Definitions extends readonly AnyJobDefinition[]> = {
  <const Queue extends string, const Name extends string, const Version extends number>(
    identity: JobIdentity<Queue, Name, Version>
  ): ResultType<RegistryMatch<Definitions, Queue, Name, Version>, JobDefinitionError>
  <const Queue extends string, const Name extends string, const Version extends number>(
    queue: Queue,
    name: Name,
    version: Version
  ): ResultType<RegistryMatch<Definitions, Queue, Name, Version>, JobDefinitionError>
}

type RegistryHas<_Definitions extends readonly AnyJobDefinition[]> = {
  <const Queue extends string, const Name extends string, const Version extends number>(
    identity: JobIdentity<Queue, Name, Version>
  ): boolean
  <const Queue extends string, const Name extends string, const Version extends number>(
    queue: Queue,
    name: Name,
    version: Version
  ): boolean
}

/** An immutable local registry of Job descriptors, with no global state. */
export interface JobRegistry<Definitions extends readonly AnyJobDefinition[]> {
  readonly definitions: Readonly<Definitions>
  readonly jobs: Readonly<Definitions>
  readonly accepted: AcceptedIdentities<Definitions>
  readonly identities: AcceptedIdentities<Definitions>
  readonly acceptedClaimIdentities: AcceptedIdentities<Definitions>
  readonly claimIdentities: AcceptedIdentities<Definitions>
  readonly get: RegistryLookup<Definitions>
  readonly lookup: RegistryLookup<Definitions>
  readonly has: RegistryHas<Definitions>
}

export type AnyJobRegistry = JobRegistry<readonly AnyJobDefinition[]>

const invalid = <Value>(field: string, message: string): ResultType<Value, JobDefinitionError> =>
  Result.err(new JobDefinitionError({ field, message }))

const identityKey = (identity: RegistryIdentityInput): string =>
  `${identity.queue.length}:${identity.queue}|${identity.name.length}:${identity.name}|${identity.version}`

const readIdentity = (
  first: unknown,
  second: unknown,
  third: unknown
): ResultType<RegistryIdentityInput, JobDefinitionError> => {
  let queue: unknown = first
  let name: unknown = second
  let version: unknown = third

  if (second === undefined && third === undefined) {
    let identity: unknown = first

    if (Job.is(first)) {
      const identityValue = readOwnDataProperty(first, 'identity')

      if (!identityValue.present) {
        return invalid('identity', 'must contain queue, name, and version')
      }

      identity = identityValue.value
    }

    if (!isPlainObject(identity)) {
      return invalid('identity', 'must contain queue, name, and version')
    }

    const queueValue = readOwnDataProperty(identity, 'queue')
    const nameValue = readOwnDataProperty(identity, 'name')
    const versionValue = readOwnDataProperty(identity, 'version')

    if (!queueValue.present || !nameValue.present || !versionValue.present) {
      return invalid('identity', 'must contain queue, name, and version')
    }

    queue = queueValue.value
    name = nameValue.value
    version = versionValue.value
  }

  const checkedQueue = makeQueueName(queue)
  const checkedName = makeJobName(name)

  if (checkedQueue.status === 'error') {
    return invalid('identity.queue', 'must be a non-empty string')
  }

  if (checkedName.status === 'error') {
    return invalid('identity.name', 'must be a non-empty string')
  }

  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) {
    return invalid('identity.version', 'must be a positive safe integer')
  }

  return Result.ok(
    Object.freeze({
      queue: checkedQueue.value,
      name: checkedName.value,
      version
    })
  )
}

const copyDefinitions = (value: unknown): readonly unknown[] => {
  try {
    if (!Array.isArray(value)) {
      throw new JobDefinitionError({ field: 'definitions', message: 'must be an array' })
    }

    return Array.from(value)
  } catch (cause) {
    if (JobDefinitionError.is(cause)) {
      throw cause
    }

    throw new JobDefinitionError({ field: 'definitions', message: 'could not read definitions' })
  }
}

const buildRegistry = (value: unknown): AnyJobRegistry => {
  const source = copyDefinitions(value)
  const definitions: AnyJobDefinition[] = []
  const identities: RegistryIdentityInput[] = []
  const byIdentity = new Map<string, AnyJobDefinition>()

  for (const [index, definition] of source.entries()) {
    if (!Job.is(definition)) {
      throw new JobDefinitionError({
        field: `definitions[${index}]`,
        message: 'must be a Job definition'
      })
    }

    const identityResult = readIdentity(definition, undefined, undefined)

    if (identityResult.status === 'error') {
      throw identityResult.error
    }

    const identity = identityResult.value
    const key = identityKey(identity)

    if (byIdentity.has(key)) {
      throw new JobDefinitionError({ field: 'definitions', message: 'duplicate job identity' })
    }

    definitions.push(definition)
    identities.push(identity)
    byIdentity.set(key, definition)
  }

  const frozenDefinitions = Object.freeze(definitions)
  const frozenIdentities = Object.freeze(
    identities.map((identity) => Object.freeze({ ...identity }))
  )

  function lookup(
    first: unknown,
    second?: unknown,
    third?: unknown
  ): ResultType<AnyJobDefinition, JobDefinitionError> {
    const identity = readIdentity(first, second, third)

    if (identity.status === 'error') {
      return Result.err(identity.error)
    }

    const definition = byIdentity.get(identityKey(identity.value))

    return definition === undefined
      ? invalid('identity', 'no Job definition is registered for this identity')
      : Result.ok(definition)
  }

  function has(first: unknown, second?: unknown, third?: unknown): boolean {
    const identity = readIdentity(first, second, third)

    return identity.status === 'ok' && byIdentity.has(identityKey(identity.value))
  }

  const registry = {
    definitions: frozenDefinitions,
    jobs: frozenDefinitions,
    accepted: frozenIdentities,
    identities: frozenIdentities,
    acceptedClaimIdentities: frozenIdentities,
    claimIdentities: frozenIdentities,
    get: lookup,
    lookup,
    has
  }

  return Object.freeze(registry) as unknown as AnyJobRegistry
}

/** Create an immutable registry while preserving the input tuple in its type. */
export const makeJobRegistry = <const Definitions extends readonly AnyJobDefinition[]>(
  definitions: Definitions
): JobRegistry<Definitions> => buildRegistry(definitions) as unknown as JobRegistry<Definitions>

/** Type-level aliases for registry tuples, unions, and accepted identities. */
export declare namespace JobRegistry {
  export type Any = AnyJobRegistry
  export type Definitions<Current extends Any = Any> =
    Current extends JobRegistry<infer Definitions> ? Definitions : never
  export type Definition<Current extends Any = Any> = Definitions<Current>[number]
  export type Jobs<Current extends Any = Any> = Definition<Current>
  export type Identities<Current extends Any = Any> =
    Current extends JobRegistry<infer Definitions> ? AcceptedIdentities<Definitions> : never
  export type Identity<Current extends Any = Any> = Identities<Current>[number]
}

export const JobRegistry = {
  make: makeJobRegistry
} as const
