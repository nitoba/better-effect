import { Err, Ok } from 'better-result'

import type { Result as ResultType } from 'better-result'

import type { EffectError, EffectSuccess } from '../effect'
import type { LayerBackend } from '../layer/backend'
import type {
  CompleteExecution,
  CompleteInput,
  LayerInput,
  ProvidedEnvironment
} from '../layer/inference'
import { Runtime } from './runtime'
import { linkAbortSignals } from './signal'

import type { RuntimeDisposeOptions, RuntimeOptions } from './outcome'
import type { RuntimeExecutionEndEvent, RuntimeObserver } from './observer'
import type { ScopeOutcome } from '../scope'

/** A Node.js/Bun process signal name; uncatchable signals are rejected at runtime. */
export type NodeRuntimeSignal =
  | 'SIGABRT'
  | 'SIGALRM'
  | 'SIGBUS'
  | 'SIGCHLD'
  | 'SIGCONT'
  | 'SIGFPE'
  | 'SIGHUP'
  | 'SIGILL'
  | 'SIGINT'
  | 'SIGIO'
  | 'SIGIOT'
  | 'SIGKILL'
  | 'SIGPIPE'
  | 'SIGPOLL'
  | 'SIGPROF'
  | 'SIGPWR'
  | 'SIGQUIT'
  | 'SIGSEGV'
  | 'SIGSTKFLT'
  | 'SIGSYS'
  | 'SIGSTOP'
  | 'SIGTERM'
  | 'SIGTRAP'
  | 'SIGTSTP'
  | 'SIGTTIN'
  | 'SIGTTOU'
  | 'SIGUNUSED'
  | 'SIGURG'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGVTALRM'
  | 'SIGWINCH'
  | 'SIGXCPU'
  | 'SIGXFSZ'
  | 'SIGBREAK'
  | 'SIGLOST'
  | 'SIGINFO'

/** Translate a successful main result to a process exit code. */
export type NodeRuntimeSuccessHandler<Success> = (value: Success) => number

/** Translate a typed main failure to a process exit code. */
export type NodeRuntimeFailureHandler<Failure> = (error: Failure) => number

/** Observe a thrown or rejected main defect while it remains a rejected Promise. */
export type NodeRuntimeDefectHandler = (cause: unknown) => number | void

/** Options for the Node.js/Bun process boundary. */
export type NodeRuntimeOptions<Success = unknown, Failure = unknown> = RuntimeOptions & {
  /** Process signals that request cooperative shutdown. Defaults to SIGINT and SIGTERM. */
  readonly signals?: readonly NodeRuntimeSignal[]
  /** Time to let the main execution settle before Runtime requests cancellation. */
  readonly gracePeriod?: number
  /** Request cancellation after `gracePeriod` while disposing the Runtime. */
  readonly abortAfterGracePeriod?: boolean
  /** Map a nominal Result.ok value, or a plain successful value, to an exit code. */
  readonly onSuccess?: NodeRuntimeSuccessHandler<Success>
  /** Map a nominal Result.err error to an exit code. */
  readonly onFailure?: NodeRuntimeFailureHandler<Failure>
  /** Observe a defect. Defects are rethrown after the handler runs. */
  readonly onDefect?: NodeRuntimeDefectHandler
}

type MainSuccess<Value> = [EffectSuccess<Value>] extends [never]
  ? Awaited<Value> extends ResultType<any, any>
    ? never
    : Awaited<Value>
  : EffectSuccess<Value>

type MainFailure<Value> = EffectError<Value>

type MainOptions<Value> = NodeRuntimeOptions<MainSuccess<Value>, MainFailure<Value>>

const DEFAULT_SIGNALS = ['SIGINT', 'SIGTERM'] as const satisfies readonly NodeRuntimeSignal[]

// SIGKILL and SIGSTOP cannot be intercepted by a process listener. The other
// names are accepted by Node's signal API, although the host may still reject
// a signal unavailable on the current platform while installing it.
const CATCHABLE_SIGNALS: ReadonlySet<string> = new Set([
  'SIGABRT',
  'SIGALRM',
  'SIGBUS',
  'SIGCHLD',
  'SIGCONT',
  'SIGFPE',
  'SIGHUP',
  'SIGILL',
  'SIGINT',
  'SIGIO',
  'SIGIOT',
  'SIGPIPE',
  'SIGPOLL',
  'SIGPROF',
  'SIGPWR',
  'SIGQUIT',
  'SIGSEGV',
  'SIGSTKFLT',
  'SIGSYS',
  'SIGTERM',
  'SIGTRAP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGUSR1',
  'SIGUSR2',
  'SIGVTALRM',
  'SIGWINCH',
  'SIGBREAK',
  'SIGUNUSED',
  'SIGLOST',
  'SIGXCPU',
  'SIGXFSZ',
  'SIGINFO'
])

type InstalledSignalListener = {
  readonly signal: NodeRuntimeSignal
  readonly listener: () => void
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- backend overload dispatch validates an opaque runtime value.
const isLayerBackend = (value: unknown): value is LayerBackend => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime overload dispatch must inspect the backend shape.
  if (value === null || typeof value !== 'object') {
    return false
  }

  return (
    'register' in value &&
    'resolve' in value &&
    'disposeAll' in value &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend contract is validated at this runtime boundary.
    typeof value.register === 'function' &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend contract is validated at this runtime boundary.
    typeof value.resolve === 'function' &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the backend contract is validated at this runtime boundary.
    typeof value.disposeAll === 'function'
  )
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- AbortSignal validation receives an opaque public option.
const isAbortSignal = (value: unknown): value is AbortSignal => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the structural host signal contract.
  if (value === null || typeof value !== 'object') {
    return false
  }

  return (
    // SAFETY: the preceding guard establishes that the opaque value is an object; these are the required AbortSignal members.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the structural host signal contract.
    typeof (value as AbortSignal).aborted === 'boolean' &&
    // SAFETY: the preceding guard establishes that the opaque value is an object; these are the required AbortSignal members.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the structural host signal contract.
    typeof (value as AbortSignal).addEventListener === 'function' &&
    // SAFETY: the preceding guard establishes that the opaque value is an object; these are the required AbortSignal members.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the structural host signal contract.
    typeof (value as AbortSignal).removeEventListener === 'function'
  )
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- options are validated at the public boundary.
const isOptionsObject = (value: unknown): value is object => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate the public options boundary before installing listeners.
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const validateExitCode = (code: number): number => {
  if (!Number.isSafeInteger(code) || code < 0) {
    throw new RangeError('NodeRuntime exit codes must be non-negative safe integers')
  }

  return code
}

const ensureFailureExitCode = (code: number): number => (code === 0 ? 1 : code)

const validateSignals = <Success, Failure>(
  signals: NodeRuntimeOptions<Success, Failure>['signals']
): void => {
  if (signals !== undefined && !Array.isArray(signals)) {
    throw new TypeError('NodeRuntime signals must be an array of supported signal names')
  }

  for (const signal of signals ?? DEFAULT_SIGNALS) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untyped options before process.on receives them.
    if (typeof signal !== 'string' || !CATCHABLE_SIGNALS.has(signal)) {
      throw new RangeError(`NodeRuntime signal "${String(signal)}" is not supported`)
    }
  }
}

const validateLifecycleOptions = <Success, Failure>(
  options: NodeRuntimeOptions<Success, Failure>
): void => {
  if (
    options.gracePeriod !== undefined &&
    (!Number.isFinite(options.gracePeriod) || options.gracePeriod < 0)
  ) {
    throw new RangeError('Runtime dispose gracePeriod must be a finite non-negative number')
  }

  if (
    options.abortAfterGracePeriod !== undefined &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untyped options before Runtime.dispose receives them.
    typeof options.abortAfterGracePeriod !== 'boolean'
  ) {
    throw new TypeError('NodeRuntime abortAfterGracePeriod must be a boolean')
  }

  if (options.signal !== undefined && !isAbortSignal(options.signal)) {
    throw new TypeError('NodeRuntime signal must be an AbortSignal')
  }
}

const validateCallbacks = <Success, Failure>(
  options: NodeRuntimeOptions<Success, Failure>
): void => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untyped options before invoking the callback.
  if (options.onSuccess !== undefined && typeof options.onSuccess !== 'function') {
    throw new TypeError('NodeRuntime onSuccess must be a function')
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untyped options before invoking the callback.
  if (options.onFailure !== undefined && typeof options.onFailure !== 'function') {
    throw new TypeError('NodeRuntime onFailure must be a function')
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untyped options before invoking the callback.
  if (options.onDefect !== undefined && typeof options.onDefect !== 'function') {
    throw new TypeError('NodeRuntime onDefect must be a function')
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate untyped options before Runtime invokes the observer.
  if (options.onCleanupFailure !== undefined && typeof options.onCleanupFailure !== 'function') {
    throw new TypeError('NodeRuntime onCleanupFailure must be a function')
  }
}

const validateOptions = <Success, Failure>(options: NodeRuntimeOptions<Success, Failure>): void => {
  validateSignals(options.signals)
  validateLifecycleOptions(options)
  validateCallbacks(options)

  if (options.observers !== undefined && !Array.isArray(options.observers)) {
    throw new TypeError('NodeRuntime observers must be an array')
  }
}

const normalizeSignals = (
  signals: readonly NodeRuntimeSignal[] | undefined
): readonly NodeRuntimeSignal[] => {
  const unique = new Set<NodeRuntimeSignal>()

  for (const signal of signals ?? DEFAULT_SIGNALS) {
    unique.add(signal)
  }

  return [...unique]
}

type MutableDisposeOptions = {
  gracePeriod?: number
  abortAfterGracePeriod?: boolean
}

const makeDisposeOptions = (
  gracePeriod: number | undefined,
  abortAfterGracePeriod: boolean | undefined
): RuntimeDisposeOptions => {
  const options: MutableDisposeOptions = {}

  if (gracePeriod !== undefined) {
    options.gracePeriod = gracePeriod
  }

  if (abortAfterGracePeriod !== undefined) {
    options.abortAfterGracePeriod = abortAfterGracePeriod
  }

  return options
}

const removeSignalListeners = (listeners: InstalledSignalListener[]): readonly unknown[] => {
  const failures: unknown[] = []

  for (const { signal, listener } of listeners) {
    try {
      process.removeListener(signal, listener)
    } catch (cause) {
      failures.push(cause)
    }
  }

  listeners.length = 0

  return failures
}

const combineFailures = (failures: readonly unknown[]): readonly unknown[] => {
  if (failures.length === 0) {
    return []
  }

  if (failures.length === 1) {
    return [failures[0]]
  }

  return [new AggregateError(failures, 'NodeRuntime cleanup failed')]
}

const setExitCode = (code: number): void => {
  process.exitCode = validateExitCode(code)
}

const reportDefect = (cause: unknown, handler: NodeRuntimeDefectHandler | undefined): void => {
  let exitCode = 1

  if (handler) {
    try {
      const requestedExitCode = handler(cause)

      if (requestedExitCode !== undefined) {
        exitCode = validateExitCode(requestedExitCode)
      }
    } catch {
      exitCode = 1
    }
  }

  setExitCode(ensureFailureExitCode(exitCode))
}

const installSignalListeners = (
  signals: readonly NodeRuntimeSignal[],
  listeners: InstalledSignalListener[],
  onSignal: (signal: NodeRuntimeSignal) => void
): void => {
  for (const signal of signals) {
    const listener = (): void => onSignal(signal)
    process.on(signal, listener)
    listeners.push({ signal, listener })
  }
}

/** Node.js/Bun process lifecycle helpers. */
export class NodeRuntime {
  /**
   * Run a typed main Program, translate its final result to `process.exitCode`,
   * and dispose the Runtime when the program or a configured process signal settles.
   */
  static runMain<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backend: LayerBackend,
    program: CompleteExecution<ProvidedEnvironment<L>, A>,
    options?: MainOptions<A>
  ): Promise<Awaited<A>>

  static runMain<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    program: CompleteExecution<ProvidedEnvironment<L>, A>,
    options?: MainOptions<A>
  ): Promise<Awaited<A>>

  static runMain<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    options: MainOptions<A>,
    program: CompleteExecution<ProvidedEnvironment<L>, A>
  ): Promise<Awaited<A>>

  static async runMain<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backendOrProgramOrOptions:
      | LayerBackend
      | MainOptions<A>
      | CompleteExecution<ProvidedEnvironment<L>, A>,
    programOrOptions?: CompleteExecution<ProvidedEnvironment<L>, A> | MainOptions<A>,
    legacyOptions?: MainOptions<A>
  ): Promise<Awaited<A>> {
    let backend: LayerBackend | undefined
    let program!: CompleteExecution<ProvidedEnvironment<L>, A>
    let options: MainOptions<A> | undefined

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes the Program callback from configuration.
    if (typeof backendOrProgramOrOptions === 'function') {
      program = backendOrProgramOrOptions
      // SAFETY: this branch is selected by the Program overload, so the optional value is its options object.
      options = programOrOptions as MainOptions<A> | undefined
    } else if (isLayerBackend(backendOrProgramOrOptions)) {
      backend = backendOrProgramOrOptions
      // SAFETY: the backend overload requires a Program in the third argument.
      program = programOrOptions as CompleteExecution<ProvidedEnvironment<L>, A>
      options = legacyOptions
    } else {
      options = backendOrProgramOrOptions
      // SAFETY: the options overload requires a Program in the third argument.
      program = programOrOptions as CompleteExecution<ProvidedEnvironment<L>, A>
    }

    if (options !== undefined && !isOptionsObject(options)) {
      throw new TypeError('NodeRuntime options must be a non-array object')
    }

    // SAFETY: validation above establishes an object; the empty object is the omitted-options case.
    const normalizedOptions = (options ?? {}) as MainOptions<A>
    validateOptions(normalizedOptions)

    const shutdownController = new AbortController()
    const configuredSignals = normalizeSignals(normalizedOptions.signals)
    const {
      gracePeriod,
      abortAfterGracePeriod,
      onSuccess,
      onFailure,
      onDefect,
      signal: callerSignal,
      ...runtimeOptions
    } = normalizedOptions
    const signalLink = linkAbortSignals(callerSignal, shutdownController.signal)
    const listeners: InstalledSignalListener[] = []
    const cleanupFailures: unknown[] = []
    const disposeOptions = makeDisposeOptions(gracePeriod, abortAfterGracePeriod)

    let runtime: Runtime<ProvidedEnvironment<L>> | undefined
    let disposalPromise: Promise<void> | undefined
    let disposalObserved = false
    let firstSignal: NodeRuntimeSignal | undefined
    let setupFailed = false
    let setupFailure: unknown
    let programFailed = false
    let programFailure: unknown
    let executionCleanupFailed = false
    let executionOutcome: ScopeOutcome | undefined
    let programSettled = false
    let programValue!: Awaited<A>

    const requestDispose = (): Promise<void> => {
      if (disposalPromise) {
        return disposalPromise
      }

      try {
        disposalPromise = runtime!.dispose(disposeOptions)
      } catch (cause) {
        disposalPromise = Promise.reject(cause)
      }

      return disposalPromise
    }

    const observeDisposal = async (): Promise<void> => {
      if (!runtime || disposalObserved) {
        return
      }

      disposalObserved = true

      try {
        await requestDispose()
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }

    const onSignal = (signal: NodeRuntimeSignal): void => {
      if (firstSignal !== undefined) {
        return
      }

      firstSignal = signal

      try {
        shutdownController.abort(signal)
      } finally {
        void requestDispose().catch(() => {})
      }
    }

    try {
      const executionObserver: RuntimeObserver = {
        onExecutionEnd: ({ outcome }: RuntimeExecutionEndEvent): void => {
          executionOutcome = outcome
        }
      }
      const runtimeOptionsWithSignal: RuntimeOptions = {
        ...runtimeOptions,
        observers: [executionObserver, ...(runtimeOptions.observers ?? [])],
        signal: signalLink.signal
      }

      runtime = backend
        ? await Runtime.make(layer, backend, runtimeOptionsWithSignal)
        : await Runtime.make(layer, runtimeOptionsWithSignal)

      installSignalListeners(configuredSignals, listeners, onSignal)

      try {
        programValue = await runtime.run(program)
        programSettled = true
      } catch (cause) {
        if (executionOutcome?.status === 'success') {
          executionCleanupFailed = true
        } else {
          programFailed = true
        }
        programFailure = cause
      }

      await observeDisposal()
    } catch (cause) {
      setupFailed = true
      setupFailure = cause
    } finally {
      await observeDisposal()
      cleanupFailures.push(...removeSignalListeners(listeners))

      try {
        signalLink.dispose()
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }

    const cleanupFailureValues = combineFailures(cleanupFailures)
    const hasCleanupFailure = cleanupFailureValues.length > 0
    const cleanupFailure = cleanupFailureValues[0]

    if (setupFailed) {
      reportDefect(setupFailure, onDefect)
      throw setupFailure
    }

    if (programFailed) {
      reportDefect(programFailure, onDefect)
      throw programFailure
    }

    if (!programSettled) {
      const failure = new Error('NodeRuntime main program did not settle')
      reportDefect(failure, onDefect)
      throw failure
    }

    if (executionCleanupFailed) {
      setExitCode(1)
      throw programFailure
    }

    if (programValue instanceof Err) {
      let exitCode = 1

      try {
        if (onFailure) {
          // SAFETY: Err carries the failure channel represented by MainFailure<A>.
          exitCode = validateExitCode(onFailure(programValue.error as MainFailure<A>))
        }
      } catch (cause) {
        reportDefect(cause, onDefect)
        throw cause
      }

      setExitCode(exitCode)
      return programValue
    }

    let exitCode = 0

    try {
      if (onSuccess) {
        const successValue = programValue instanceof Ok ? programValue.value : programValue
        // SAFETY: Ok is unwrapped above; plain successful values retain the MainSuccess<A> channel.
        exitCode = validateExitCode(onSuccess(successValue as MainSuccess<A>))
      }
    } catch (cause) {
      reportDefect(cause, onDefect)
      throw cause
    }

    if (hasCleanupFailure) {
      exitCode = ensureFailureExitCode(exitCode)
    }

    setExitCode(exitCode)

    if (hasCleanupFailure) {
      throw cleanupFailure
    }

    return programValue
  }
}

/** Type-level aliases for the Node.js/Bun process boundary. */
export declare namespace NodeRuntime {
  /** Options for `NodeRuntime.runMain`. */
  export type Options<Success = unknown, Failure = unknown> = NodeRuntimeOptions<Success, Failure>

  /** A process signal accepted by `NodeRuntime.runMain`. */
  export type Signal = NodeRuntimeSignal
}
