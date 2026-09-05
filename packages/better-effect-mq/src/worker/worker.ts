// oxlint-disable anti-slop/no-runtime-typeof -- Worker is a public JavaScript boundary in addition to a typed API.
// oxlint-disable anti-slop/no-unknown-parameters -- handler and store values are validated before entering the supervisor.
// oxlint-disable anti-slop/no-unknown-returns -- runtime Result values are normalized at the Runtime boundary.
// oxlint-disable anti-slop/no-chained-type-assertions -- generic handler details are erased only after runtime validation.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions are confined to validated public boundaries.

import { Effect } from 'better-effect'
import type { RuntimeExecutor } from 'better-effect'
import { Result, type Result as ResultType } from 'better-result'

import { Job, type AnyJobDefinition } from '../job'
import { JobDefinitionError } from '../protocol'
import { assertJobStoreProtocolCompatible } from '../store'
import type { AnyJobStoreToken, JobStore as JobStoreNamespace } from '../store'

import { normalizeWorkerOptions, WorkerSupervisor } from './supervisor'
import type {
  AnyWorkerHandler,
  CompleteWorkerOptions,
  WorkerHandler,
  WorkerHandlerOptions,
  WorkerHandle,
  WorkerOptions
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

/** Start a Worker over a non-owning Runtime executor capability. */
export function startWith<
  Provided extends import('better-effect').AnyService,
  const Handlers extends readonly AnyWorkerHandler[]
>(
  executor: RuntimeExecutor<Provided>,
  options: CompleteWorkerOptions<Provided, Handlers>
): Promise<WorkerHandle>
export async function startWith<Provided extends import('better-effect').AnyService>(
  executor: RuntimeExecutor<Provided>,
  options: WorkerOptions<readonly AnyWorkerHandler[]>
): Promise<WorkerHandle> {
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
export const Worker = Object.freeze({ handle, startWith } as const)

export namespace Worker {
  export type Handler<
    Definition extends AnyJobDefinition = AnyJobDefinition,
    Requirements extends import('better-effect').AnyService = import('better-effect').AnyService
  > = import('./types').WorkerHandler<Definition, Requirements>
  export type AnyHandler = AnyWorkerHandler
  export type Options<Handlers extends readonly AnyWorkerHandler[] = readonly AnyWorkerHandler[]> =
    WorkerOptions<Handlers>
  export type ReliabilityOptions = import('./types').WorkerReliabilityOptions
  export type CompleteOptions<
    Provided extends import('better-effect').AnyService,
    Handlers extends readonly AnyWorkerHandler[]
  > = CompleteWorkerOptions<Provided, Handlers>
  export type Handle = WorkerHandle
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
