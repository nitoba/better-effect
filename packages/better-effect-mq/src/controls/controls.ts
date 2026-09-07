// oxlint-disable anti-slop/no-runtime-typeof -- controls are validated at public descriptor boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- descriptor callbacks and registries cross an untyped API boundary.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- optional descriptor fields are assembled after validation.
// oxlint-disable anti-slop/no-chained-type-assertions -- assertions stay at the Service/Layer erasure boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated descriptors justify localized assertions.

import { Layer, Service } from 'better-effect'

import { Queue } from '../job'
import type { QueueDefinition } from '../job'
import { JobDefinitionError } from '../protocol'
import type {
  AnyQueueControlsRegistry,
  AnyQueueControlDefinition,
  ControlsReconcileOptions,
  ControlsReconcileReport,
  QueueControlDefinition,
  QueueControlsEffect,
  QueueControlsInstance,
  QueueControlsOptions,
  QueueControlsRegistry,
  QueueControlsToken
} from './types'
import { controlsExtension, controlsProtocolVersion } from './types'
import type { ControlledJobStoreContract } from '../store/controlled'

const tokenTag = '@better-effect/mq/QueueControls' as const

const positive = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new JobDefinitionError({ field, message: 'must be a positive safe integer' })
  }
  return value
}

const validateOptions = <Payload>(
  value: QueueControlsOptions<Payload>
): QueueControlsOptions<Payload> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobDefinitionError({ field: 'controls', message: 'must be an object' })
  }
  const globalConcurrency =
    value.globalConcurrency === undefined
      ? undefined
      : positive(value.globalConcurrency, 'globalConcurrency')
  const concurrencyKey =
    value.concurrencyKey === undefined
      ? undefined
      : (() => {
          if (typeof value.concurrencyKey?.derive !== 'function') {
            throw new JobDefinitionError({
              field: 'concurrencyKey.derive',
              message: 'must be callable'
            })
          }
          return Object.freeze({
            derive: value.concurrencyKey.derive,
            max: positive(value.concurrencyKey.max, 'concurrencyKey.max')
          })
        })()
  const perKeyConcurrency =
    value.perKeyConcurrency === undefined
      ? concurrencyKey?.max
      : positive(value.perKeyConcurrency, 'perKeyConcurrency')
  if (
    concurrencyKey !== undefined &&
    value.perKeyConcurrency !== undefined &&
    perKeyConcurrency !== concurrencyKey.max
  ) {
    throw new JobDefinitionError({
      field: 'perKeyConcurrency',
      message: 'must match concurrencyKey.max'
    })
  }
  const rateLimit =
    value.rateLimit === undefined
      ? undefined
      : Object.freeze({
          max: positive(value.rateLimit.max, 'rateLimit.max'),
          durationMs: positive(value.rateLimit.durationMs, 'rateLimit.durationMs')
        })
  return Object.freeze({
    ...(globalConcurrency === undefined ? {} : { globalConcurrency }),
    ...(perKeyConcurrency === undefined ? {} : { perKeyConcurrency }),
    ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
    ...(rateLimit === undefined ? {} : { rateLimit })
  })
}

const define = <const QueueName extends string, Payload = unknown>(
  queue: QueueDefinition<QueueName>,
  options?: QueueControlsOptions<Payload>
): QueueControlDefinition<QueueDefinition<QueueName>, Payload> => {
  if (!Queue.is(queue))
    throw new JobDefinitionError({ field: 'queue', message: 'must be a Queue definition' })
  return Object.freeze({ queue: queue.queue, options: validateOptions(options ?? {}) })
}

const registry = <const Definitions extends readonly AnyQueueControlDefinition[]>(input: {
  readonly group: string
  readonly controls: Definitions
}): QueueControlsRegistry<Definitions> => {
  if (typeof input?.group !== 'string' || input.group.length === 0) {
    throw new JobDefinitionError({ field: 'group', message: 'must be a non-empty string' })
  }
  if (!Array.isArray(input.controls)) {
    throw new JobDefinitionError({ field: 'controls', message: 'must be an array' })
  }
  const seen = new Set<string>()
  for (const control of input.controls) {
    if (control === null || typeof control !== 'object' || typeof control.queue !== 'string') {
      throw new JobDefinitionError({ field: 'controls', message: 'contains an invalid definition' })
    }
    if (seen.has(control.queue)) {
      throw new JobDefinitionError({ field: 'controls', message: 'contains a duplicate queue' })
    }
    seen.add(control.queue)
  }
  return Object.freeze({
    group: input.group,
    controls: Object.freeze(Array.from(input.controls))
  }) as QueueControlsRegistry<Definitions>
}

const makeToken = <const Tag extends string>(tag: Tag): QueueControlsToken<Tag> => {
  type Instance = QueueControlsInstance<Tag>
  const token = Service<Instance>()(tag as never)
  const layer = (factory: () => Instance | ControlledJobStoreContract) =>
    Layer.make(token, () => {
      const implementation = factory()
      if ('getControls' in implementation) {
        const store = implementation
        return {
          descriptor: {
            extension: controlsExtension,
            extensionVersion: controlsProtocolVersion,
            jobStoreProtocolVersion: 1
          },
          reconcile: store.reconcile.bind(store),
          get: (queue: import('../protocol').QueueName) => store.getControls({ queue }),
          claimControlled: store.claimControlled.bind(store),
          settleControlled: store.settleControlled.bind(store),
          releaseControlled: store.releaseControlled.bind(store),
          recoverStalledControlled: store.recoverStalledControlled.bind(store),
          cancelControlled: store.cancelControlled.bind(store)
        } as unknown as Instance
      }
      return implementation as Instance
    }) as unknown as import('better-effect').Layer<Instance, never>
  Object.defineProperty(token, 'layer', {
    configurable: false,
    enumerable: true,
    value: layer,
    writable: false
  })
  return token as unknown as QueueControlsToken<Tag>
}

const defaultToken = makeToken(tokenTag)

const reconcile = (
  controls: AnyQueueControlsRegistry,
  options?: ControlsReconcileOptions
): QueueControlsEffect<ControlsReconcileReport> =>
  (async function* () {
    const implementation = yield* defaultToken
    return yield* implementation.reconcile(controls, options)
  })()

const get = (
  queue: import('../protocol').QueueName
): QueueControlsEffect<import('../store/controlled').QueueControlsRecord | undefined> =>
  (async function* () {
    const implementation = yield* defaultToken
    return yield* implementation.get(queue)
  })()

const service = <const Tag extends string>(tag: Tag): QueueControlsToken<Tag> => makeToken(tag)

const dispatchKey = <QueueName extends string>(
  definition: QueueControlDefinition<QueueDefinition<QueueName>>,
  payload: unknown
): string | undefined => {
  const derive = definition.options.concurrencyKey?.derive
  if (derive === undefined) return undefined
  const value = derive(payload)
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value === '__none__' ||
    value.includes('\0')
  ) {
    throw new JobDefinitionError({
      field: 'dispatchKey',
      message: 'must be a non-empty bounded string without NUL or the reserved __none__ value'
    })
  }
  return value
}

const api: QueueControlsToken<typeof tokenTag> & {
  readonly TypeId: typeof controlsExtension
  readonly protocolVersion: typeof controlsProtocolVersion
  readonly define: typeof define
  readonly registry: typeof registry
  readonly reconcile: typeof reconcile
  readonly get: typeof get
  readonly service: typeof service
  readonly dispatchKey: typeof dispatchKey
} = Object.assign(defaultToken, {
  TypeId: controlsExtension,
  protocolVersion: controlsProtocolVersion,
  define,
  registry,
  reconcile,
  get,
  service,
  dispatchKey
})

export { api as QueueControls }
