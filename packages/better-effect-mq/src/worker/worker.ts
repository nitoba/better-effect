// oxlint-disable anti-slop/no-runtime-typeof -- Worker is a public JavaScript boundary in addition to a typed API.
// oxlint-disable anti-slop/no-unknown-parameters -- handler and store values are validated before entering the supervisor.
// oxlint-disable anti-slop/no-unknown-returns -- runtime Result values are normalized at the Runtime boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- generic handler details are erased only after runtime validation.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are confined to validated public boundaries.

import { Effect, Layer, Runtime, Service } from 'better-effect'
import type { AnyService, RuntimeExecutor, ServiceRequirement, ServiceToken } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import { Job, type AnyJobDefinition } from '../job'
import { JobDefinitionError } from '../protocol'
import { assertJobStoreProtocolCompatible } from '../store'
import type { AnyJobStoreToken, JobStore as JobStoreNamespace } from '../store'

import { normalizeWorkerOptions, WorkerSupervisor } from './supervisor'
import type {
  AnyWorkerHandler,
  WorkerHandler,
  WorkerHandlerOptions,
  WorkerHandle,
  WorkerLayerRequirements,
  WorkerOptions,
  WorkerServiceGeneratorFactory,
  WorkerServiceInstance,
  WorkerServiceTag,
  WorkerServiceToken,
  WorkerRequirements
} from './types'

/** Register one immutable, typed Job handler descriptor. */
export function handle<
  const Definition extends AnyJobDefinition,
  const Program extends Effect.Program<
    Job.Success<Definition>,
    Job.Failure<Definition>,
    import('better-effect').AnyService
  >
>(
  job: Definition,
  handler: (payload: Job.Payload<Definition>) => Program,
  options: WorkerHandlerOptions = {}
): WorkerHandler<Definition, Effect.Requirements<Program>> {
  validateJob(job)
  validateHandler(handler)
  validateOptionsObject(options, 'handler options')
  const concurrencyField = readOwnField(options, 'concurrency', 'handler options.concurrency')
  const concurrency = validateOptionalConcurrency(
    concurrencyField.present ? concurrencyField.value : undefined
  )

  return Object.freeze({
    job,
    definition: job,
    handler,
    run: handler,
    concurrency
  }) as unknown as WorkerHandler<Definition, Effect.Requirements<Program>>
}

type WorkerServiceValueFactory<Handlers extends readonly AnyWorkerHandler[]> = () =>
  | WorkerOptions<Handlers>
  | PromiseLike<WorkerOptions<Handlers>>

type WorkerServiceFactoryInput<
  Handlers extends readonly AnyWorkerHandler[],
  Yield extends ServiceRequirement<unknown>
> = WorkerServiceGeneratorFactory<Handlers, Yield> | WorkerServiceValueFactory<Handlers>

type WorkerServiceGeneratorResult<
  Handlers extends readonly AnyWorkerHandler[],
  Yield extends ServiceRequirement<unknown>
> =
  | Generator<Yield, WorkerOptions<Handlers>, unknown>
  | AsyncGenerator<Yield, WorkerOptions<Handlers>, unknown>

// oxlint-disable-next-line anti-slop/no-runtime-typeof -- this boundary distinguishes a factory generator from an options Promise/value.
const isWorkerServiceGeneratorResult = <
  Handlers extends readonly AnyWorkerHandler[],
  Yield extends ServiceRequirement<unknown>
>(
  value:
    | WorkerOptions<Handlers>
    | PromiseLike<WorkerOptions<Handlers>>
    | WorkerServiceGeneratorResult<Handlers, Yield>
): value is WorkerServiceGeneratorResult<Handlers, Yield> =>
  typeof value === 'object' &&
  value !== null &&
  'next' in value &&
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- generator protocol validation at the factory boundary.
  typeof value.next === 'function'

const normalizeWorkerServiceFactory = <
  Handlers extends readonly AnyWorkerHandler[],
  Yield extends ServiceRequirement<unknown>
>(
  factory: WorkerServiceFactoryInput<Handlers, Yield>
): (() => AsyncGenerator<Yield, WorkerOptions<Handlers>, unknown>) =>
  async function* () {
    const result = factory()

    if (isWorkerServiceGeneratorResult<Handlers, Yield>(result)) {
      return yield* result
    }

    return await result
  }

const quiesceWorker = (worker: WorkerHandle): void => {
  // SAFETY: only WorkerSupervisor instances reach this callback; test doubles use Worker.succeed and have no lifecycle callback.
  const supervisor = worker as WorkerHandle & { readonly quiesce: () => void }
  supervisor.quiesce()
}

/** Create a non-constructible, yieldable Worker Service token. */
export function service<const Tag extends string>(
  tag: WorkerServiceTag<Tag>
): WorkerServiceToken<Tag> {
  type Instance = WorkerServiceInstance<Tag>

  const baseToken = Service<Instance>()(tag)
  // SAFETY: the generated token is used only as a Service identity; its constructor rejects manual ownership.
  const token = class extends (baseToken as unknown as new () => Service.Identity<Tag>) {
    constructor() {
      super()
      throw new TypeError('Worker Service tokens are not constructible; use layer or succeed')
    }
  }
  // SAFETY: this is the single token erasure boundary for the non-constructible Service class.
  const layerToken = token as unknown as ServiceToken<Tag, Instance>

  const makeLayer = <
    const Handlers extends readonly AnyWorkerHandler[],
    Yield extends ServiceRequirement<unknown>
  >(
    factory: WorkerServiceFactoryInput<Handlers, Yield>
  ): Layer<Instance, WorkerLayerRequirements<Handlers, Yield>> => {
    const layer = Layer.scopedGen(
      layerToken,
      async function* () {
        const options = yield* normalizeWorkerServiceFactory(factory)()
        // Runtime.executor is contextual and deliberately erased from Layer.Required: the Runtime owns this capability.
        const executor = yield* Runtime.executor<AnyService>()
        const worker = await startWorkerWithExecutor(executor, options)
        return layerToken.of(worker)
      },
      {
        quiesce: quiesceWorker,
        release: (worker) => worker.stop()
      }
    )

    // SAFETY: Runtime.executor is acquired from the active Runtime context rather than a Layer Service; only factory and handler requirements remain public.
    return layer as Layer<Instance, WorkerLayerRequirements<Handlers, Yield>>
  }

  function layer<
    const Handlers extends readonly AnyWorkerHandler[],
    Yield extends ServiceRequirement<unknown>
  >(
    factory: WorkerServiceGeneratorFactory<Handlers, Yield>
  ): Layer<Instance, WorkerLayerRequirements<Handlers, Yield>>
  function layer<const Handlers extends readonly AnyWorkerHandler[]>(
    factory: WorkerServiceValueFactory<Handlers>
  ): Layer<Instance, WorkerRequirements<Handlers>>
  function layer(
    factory: WorkerServiceFactoryInput<readonly AnyWorkerHandler[], ServiceRequirement<unknown>>
  ): Layer<Instance, AnyService> {
    return makeLayer(factory)
  }

  const succeed = (worker: WorkerHandle): Layer<Instance, never> =>
    // SAFETY: Worker.succeed is the caller-owned test-double boundary and does not register a release callback.
    Layer.succeed(layerToken, worker) as unknown as Layer<Instance, never>

  Object.defineProperties(token, {
    layer: {
      configurable: false,
      enumerable: true,
      value: layer,
      writable: false
    },
    succeed: {
      configurable: false,
      enumerable: true,
      value: succeed,
      writable: false
    }
  })

  // SAFETY: locked helpers restore the precise token type after the constructor and Layer storage erasures.
  return token as unknown as WorkerServiceToken<Tag>
}

const startWorkerWithExecutor = async (
  executor: RuntimeExecutor<any>,
  options: WorkerOptions<readonly AnyWorkerHandler[]>
): Promise<WorkerSupervisor<any>> => {
  validateExecutor(executor)
  validateOptionsObject(options, 'options')
  const handlersField = readOwnField(options, 'handlers', 'options.handlers')
  const normalizedHandlers = normalizeHandlers(
    handlersField.present ? handlersField.value : undefined
  )
  const normalizedOptions = normalizeWorkerOptions(options)
  await assertStoresAvailable(executor, normalizedHandlers)

  const supervisor = new WorkerSupervisor(executor, normalizedHandlers, normalizedOptions)
  supervisor.start()
  return supervisor
}

/** Worker entrypoints and the immutable handler constructor. */
export const Worker = Object.freeze({ handle, service } as const)

export namespace Worker {
  export type Handler<
    Definition extends AnyJobDefinition = AnyJobDefinition,
    Requirements extends import('better-effect').AnyService = import('better-effect').AnyService
  > = import('./types').WorkerHandler<Definition, Requirements>
  export type AnyHandler = AnyWorkerHandler
  export type Options<Handlers extends readonly AnyWorkerHandler[] = readonly AnyWorkerHandler[]> =
    WorkerOptions<Handlers>
  export type ReliabilityOptions = import('./types').WorkerReliabilityOptions
  export type Handle = WorkerHandle
  export type ServiceInstance<Tag extends string> = WorkerServiceInstance<Tag>
  export type ServiceToken<Tag extends string> = WorkerServiceToken<Tag>
  export type LayerRequirements<
    Handlers extends readonly AnyWorkerHandler[],
    Yield extends ServiceRequirement<unknown>
  > = WorkerLayerRequirements<Handlers, Yield>
}

const validateOptionsObject = (value: unknown, field: string): void => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new JobDefinitionError({ field, message: 'must be an object' })
  }
}

const validateExecutor: (executor: unknown) => asserts executor is RuntimeExecutor<any> = (
  executor
) => {
  if (executor === null || typeof executor !== 'object') {
    throw new JobDefinitionError({ field: 'executor', message: 'must be a Runtime.Executor' })
  }

  let run: unknown
  let runWith: unknown
  try {
    run = (executor as { readonly run?: unknown }).run
    runWith = (executor as { readonly runWith?: unknown }).runWith
  } catch {
    throw new JobDefinitionError({ field: 'executor', message: 'could not read executor' })
  }

  if (typeof run !== 'function' || typeof runWith !== 'function') {
    throw new JobDefinitionError({ field: 'executor', message: 'must implement run and runWith' })
  }
}

const normalizeHandlers = (value: unknown): readonly AnyWorkerHandler[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new JobDefinitionError({
      field: 'handlers',
      message: 'must contain at least one handler'
    })
  }

  const seen = new Set<string>()
  const handlers: AnyWorkerHandler[] = []

  for (const [index, candidate] of value.entries()) {
    const handler = normalizeHandler(candidate, index)
    const identityKey = identityKeyFor(handler.job)

    if (seen.has(identityKey)) {
      throw new JobDefinitionError({
        field: `handlers[${index}]`,
        message: `duplicate handler identity ${identityKey}`
      })
    }

    seen.add(identityKey)
    handlers.push(handler)
  }

  return Object.freeze(handlers)
}

const normalizeHandler = (candidate: unknown, index: number): AnyWorkerHandler => {
  if (candidate === null || typeof candidate !== 'object') {
    throw new JobDefinitionError({
      field: `handlers[${index}]`,
      message: 'must be a Worker.handle descriptor'
    })
  }

  const prefix = `handlers[${index}]`
  const jobField = readOwnField(candidate, 'job', `${prefix}.job`)
  const definitionField = readOwnField(candidate, 'definition', `${prefix}.definition`)
  const handlerField = readOwnField(candidate, 'handler', `${prefix}.handler`)
  const runField = readOwnField(candidate, 'run', `${prefix}.run`)
  const concurrencyField = readOwnField(candidate, 'concurrency', `${prefix}.concurrency`)
  const job = jobField.present
    ? jobField.value
    : definitionField.present
      ? definitionField.value
      : undefined
  const handler = handlerField.present
    ? handlerField.value
    : runField.present
      ? runField.value
      : undefined

  validateJob(job, `${prefix}.job`)
  validateHandler(handler, `${prefix}.handler`)

  if (jobField.present && definitionField.present && jobField.value !== definitionField.value) {
    throw new JobDefinitionError({
      field: prefix,
      message: 'job and definition aliases must refer to the same Job'
    })
  }

  if (handlerField.present && runField.present && handlerField.value !== runField.value) {
    throw new JobDefinitionError({
      field: prefix,
      message: 'handler and run aliases must refer to the same callback'
    })
  }

  const concurrency = validateOptionalConcurrency(
    concurrencyField.present ? concurrencyField.value : undefined,
    `${prefix}.concurrency`
  )
  return Object.freeze({
    job,
    definition: job,
    handler,
    run: handler,
    concurrency
  }) as AnyWorkerHandler
}

function validateJob(job: unknown, field = 'job'): asserts job is AnyJobDefinition {
  if (!Job.is(job)) {
    throw new JobDefinitionError({ field, message: 'must be a valid Job definition' })
  }
}

const validateHandler = (handler: unknown, field = 'handler'): void => {
  if (typeof handler !== 'function') {
    throw new JobDefinitionError({ field, message: 'must be callable' })
  }
}

type DataField = { readonly present: true; readonly value: unknown } | { readonly present: false }
type WorkerDescriptorObject = object

const readOwnField = (
  // oxlint-disable-next-line anti-slop/no-object-parameters -- this helper receives an already object-validated public descriptor.
  value: WorkerDescriptorObject,
  key: string,
  field: string
): DataField => {
  let descriptor: PropertyDescriptor | undefined

  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key)
  } catch {
    throw new JobDefinitionError({ field, message: 'could not read descriptor' })
  }

  if (descriptor === undefined) {
    return { present: false }
  }

  if (!('value' in descriptor)) {
    throw new JobDefinitionError({ field, message: 'must be a data property' })
  }

  return { present: true, value: descriptor.value }
}

const validateOptionalConcurrency = (value: unknown, field = 'concurrency'): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new JobDefinitionError({ field, message: 'must be a positive safe integer' })
  }

  return value
}

const identityKeyFor = (job: Pick<AnyJobDefinition, 'queue' | 'name' | 'version'>): string =>
  JSON.stringify([job.queue, job.name, job.version])

const assertStoresAvailable = async (
  executor: RuntimeExecutor<any>,
  handlers: readonly AnyWorkerHandler[]
): Promise<void> => {
  const stores = new Map<string, AnyJobStoreToken>()

  for (const handler of handlers) {
    stores.set(handler.job.store.serviceTag, handler.job.store)
  }

  for (const store of stores.values()) {
    await assertStoreAvailable(executor, store)
  }
}

const assertStoreAvailable = async (
  executor: RuntimeExecutor<any>,
  token: AnyJobStoreToken
): Promise<void> => {
  const result = (await executor.run(
    () =>
      Effect.gen(async function* () {
        const store = yield* token
        return Result.ok(store)
      }) as never
  )) as ResultType<JobStoreNamespace.Contract, unknown>

  if (Result.isError(result)) {
    throw result.error
  }

  assertJobStoreProtocolCompatible(result.value.descriptor)
}
