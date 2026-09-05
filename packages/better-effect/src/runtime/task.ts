import { Err } from 'better-result'

import type { Result as ResultType } from 'better-result'

import { getProgramName, type ProgramIdentity } from '../effect/program-metadata'
import type { ScopedTask, ScopedTaskExit, ScopedTaskState } from '../effect/task'
import type { EffectError, EffectSuccess, Program } from '../effect/types'
import type { AnyService } from '../service'
import { addScopePreFinalizer, runScoped } from '../scope/internal'
import type {
  CleanupFailureDiagnostic,
  CloseableScope,
  MaybePromise,
  Scope,
  ScopeCloseError,
  ScopeOutcome
} from '../scope'

import {
  activeRuntimeContextStorage,
  makeRuntimeContext,
  type CompleteRuntimeContext,
  type RuntimeContext,
  type RuntimeContextStorage
} from './context'
import { RuntimeContextNotConfiguredError } from './errors'
import { notifyRuntimeObservers } from './observer'
import type { RuntimeObserver, RuntimeTaskEndEvent, RuntimeTaskStartEvent } from './observer'
import type { RuntimeTaskInspection } from './types'
import { classifyRuntimeOutcome } from './outcome'
import { linkAbortSignals, type AbortSignalLink } from './signal'

const taskSupervisors = new WeakMap<object, RuntimeTaskSupervisor>()

/** Associate one Runtime task supervisor with a Runtime-owned Scope. */
export const bindRuntimeTaskSupervisor = (
  scope: Scope,
  supervisor: RuntimeTaskSupervisor
): void => {
  taskSupervisors.set(scope, supervisor)
}

/** Return the supervisor associated with the current Runtime-owned Scope. */
export const getRuntimeTaskSupervisor = (scope: Scope): RuntimeTaskSupervisor | undefined =>
  taskSupervisors.get(scope)

type TaskState = Exclude<ScopedTaskState, 'running'>

type TaskMetadata = {
  readonly taskId: string
  readonly parentExecutionId?: string
  readonly name?: string
  readonly startedAt: number
}

type MutableTaskMetadata = {
  taskId: string
  parentExecutionId?: string
  name?: string
  startedAt: number
}

type MutableTaskEndEvent = MutableTaskMetadata & {
  state: TaskState
  cleanupFailure?: ScopeCloseError
}

type AnyProgram = Program<any, any, AnyService>

type TaskRecord<Input extends AnyProgram> = {
  readonly metadata: TaskMetadata
  readonly childScope: CloseableScope
  readonly signalLink: AbortSignalLink
  readonly handle: ScopedTaskHandle<EffectSuccess<Input>, EffectError<Input>>
  readonly program: Input
  readonly context: CompleteRuntimeContext
  readonly storage: RuntimeContextStorage
}

const defaultInterruptionReason = (): Error => {
  const reason = new Error('Scoped task interrupted')
  reason.name = 'ScopedTaskInterruptedError'
  return reason
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- AbortSignal reasons preserve caller-defined diagnostic values.
const signalReason = (signal: AbortSignal): unknown =>
  signal.reason === undefined ? defaultInterruptionReason() : signal.reason

const taskStateFromExit = <A, E>(exit: ScopedTaskExit<A, E>): TaskState => exit.status

const copyMetadata = (metadata: TaskMetadata): TaskMetadata => {
  const copy: MutableTaskMetadata = {
    taskId: metadata.taskId,
    startedAt: metadata.startedAt
  }

  if (metadata.parentExecutionId !== undefined) {
    copy.parentExecutionId = metadata.parentExecutionId
  }

  if (metadata.name !== undefined) {
    copy.name = metadata.name
  }

  return Object.freeze(copy)
}

type TaskHandleState<A, E> = {
  readonly completion: Promise<ScopedTaskExit<A, E>>
  readonly resolveCompletion: (exit: ScopedTaskExit<A, E>) => void
  currentState: ScopedTaskState
  terminalResult: ResultType<A, E> | undefined
  interruptionReasonValue: unknown
}

class ScopedTaskHandle<A, E> implements ScopedTask<A, E> {
  private readonly handleState: TaskHandleState<A, E>

  constructor(private readonly controller: AbortController) {
    let resolveCompletion!: (exit: ScopedTaskExit<A, E>) => void
    const completion = new Promise<ScopedTaskExit<A, E>>((resolve) => {
      resolveCompletion = resolve
    })
    this.handleState = {
      completion,
      resolveCompletion,
      currentState: 'running',
      terminalResult: undefined,
      interruptionReasonValue: undefined
    }
    Object.freeze(this)
  }

  get state(): ScopedTaskState {
    return this.handleState.currentState
  }

  await(): Promise<ResultType<A, E>> {
    return this.handleState.completion.then((exit) => {
      if (exit.status === 'succeeded' || exit.status === 'failed') {
        return this.handleState.terminalResult!
      }

      if (exit.status === 'defected') {
        throw exit.cause
      }

      throw exit.reason
    })
  }

  awaitExit(): Promise<ScopedTaskExit<A, E>> {
    return this.handleState.completion
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Task interruption preserves the caller's arbitrary abort reason.
  interrupt(reason?: unknown): Promise<void> {
    if (this.handleState.currentState !== 'running') {
      return this.handleState.completion.then(() => undefined)
    }

    const interruption =
      reason === undefined
        ? (this.handleState.interruptionReasonValue ?? defaultInterruptionReason())
        : reason
    this.handleState.interruptionReasonValue = interruption

    if (!this.controller.signal.aborted) {
      this.controller.abort(interruption)
    }

    return this.handleState.completion.then(() => undefined)
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Linked AbortSignals carry arbitrary caller-defined reasons.
  markInterrupted(reason: unknown): void {
    if (
      this.handleState.currentState === 'running' &&
      this.handleState.interruptionReasonValue === undefined
    ) {
      this.handleState.interruptionReasonValue = reason
    }
  }

  isInterrupted(): boolean {
    return this.handleState.interruptionReasonValue !== undefined || this.controller.signal.aborted
  }

  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Task exits preserve arbitrary interruption reasons.
  interruptionReason(signal: AbortSignal): unknown {
    return this.handleState.interruptionReasonValue ?? signalReason(signal)
  }

  settle(exit: ScopedTaskExit<A, E>, result?: ResultType<A, E>): void {
    if (this.handleState.currentState !== 'running') {
      return
    }

    const terminalExit = Object.freeze(exit)
    this.handleState.currentState = taskStateFromExit(terminalExit)
    this.handleState.terminalResult = result
    this.handleState.resolveCompletion(terminalExit)
  }
}

const withCleanupFailure = <A extends object>(
  value: A,
  cleanupFailure: ScopeCloseError | undefined
): A => {
  if (cleanupFailure === undefined) {
    // SAFETY: `value` already has the requested exit shape; freezing a shallow copy preserves it.
    return Object.freeze({ ...value }) as A
  }

  // SAFETY: The added diagnostic property is the only runtime extension of the typed exit shape.
  return Object.freeze({ ...value, cleanupFailure }) as A
}

/** Runtime-owned supervisor for Scope child tasks. */
export class RuntimeTaskSupervisor {
  private readonly tasks = new Map<string, TaskRecord<AnyProgram>>()

  constructor(
    private readonly createTaskId: () => string,
    private readonly now: () => number,
    private readonly observers: readonly RuntimeObserver[],
    private readonly onCleanupFailure:
      | ((diagnostic: CleanupFailureDiagnostic) => MaybePromise<void>)
      | undefined
  ) {}

  bindScope(scope: Scope): void {
    bindRuntimeTaskSupervisor(scope, this)
  }

  inspect(): readonly RuntimeTaskInspection[] {
    return Object.freeze(
      [...this.tasks.values()].map(({ metadata }) =>
        Object.freeze({
          ...copyMetadata(metadata),
          state: 'running' as const
        })
      )
    )
  }

  forkScoped<Input extends AnyProgram>(
    program: Input,
    context: CompleteRuntimeContext
  ): ScopedTask<EffectSuccess<Input>, EffectError<Input>> {
    if (!context.resolver || !context.scope) {
      throw new RuntimeContextNotConfiguredError()
    }

    const parentScope = context.scope
    const childScope = parentScope.fork()
    const controller = new AbortController()
    const signalLink = linkAbortSignals(context.signal, controller.signal)
    const handle = new ScopedTaskHandle<EffectSuccess<Input>, EffectError<Input>>(controller)
    const metadata = this.makeMetadata(program, context)
    const storage = activeRuntimeContextStorage()
    const record: TaskRecord<Input> = {
      metadata,
      childScope,
      signalLink,
      handle,
      program,
      context,
      storage
    }
    const onAbort = (): void => handle.markInterrupted(signalReason(signalLink.signal))

    try {
      addScopePreFinalizer(parentScope, (outcome) =>
        handle.interrupt(outcome.status === 'failure' ? outcome.cause : undefined)
      )
      this.bindScope(childScope)
      this.tasks.set(metadata.taskId, record)
      signalLink.signal.addEventListener('abort', onAbort, { once: true })
      if (signalLink.signal.aborted) {
        onAbort()
      }
      this.notifyStart(metadata)
    } catch (cause) {
      signalLink.signal.removeEventListener('abort', onAbort)
      signalLink.dispose()
      void childScope.close({ status: 'failure', cause }).catch(() => {})
      throw cause
    }

    void this.runTask(record, onAbort)

    return handle
  }

  private makeMetadata(program: ProgramIdentity, context: RuntimeContext): TaskMetadata {
    const metadata: MutableTaskMetadata = {
      taskId: this.createTaskId(),
      startedAt: this.now()
    }
    const name = getProgramName(program)

    if (name !== undefined) {
      metadata.name = name
    }

    if (context.executionId !== undefined) {
      metadata.parentExecutionId = context.executionId
    }

    return Object.freeze(metadata)
  }

  private notifyStart(metadata: TaskMetadata): void {
    const event: RuntimeTaskStartEvent = {
      ...copyMetadata(metadata),
      state: 'running'
    }
    notifyRuntimeObservers(this.observers, (observer) => observer.onTaskStart, Object.freeze(event))
  }

  private notifyEnd<A, E>(metadata: TaskMetadata, exit: ScopedTaskExit<A, E>): void {
    const event: MutableTaskEndEvent = {
      ...copyMetadata(metadata),
      state: exit.status
    }

    if (exit.cleanupFailure !== undefined) {
      event.cleanupFailure = exit.cleanupFailure
    }

    const frozenEvent: RuntimeTaskEndEvent = Object.freeze(event)

    notifyRuntimeObservers(this.observers, (observer) => observer.onTaskEnd, frozenEvent)
  }

  private async runTask<Input extends AnyProgram>(
    record: TaskRecord<Input>,
    onAbort: () => void
  ): Promise<void> {
    let cleanupFailure: ScopeCloseError | undefined
    const onChildCleanupFailure = async (diagnostic: CleanupFailureDiagnostic): Promise<void> => {
      cleanupFailure = diagnostic.error

      if (this.onCleanupFailure !== undefined) {
        await this.onCleanupFailure(diagnostic)
      }
    }
    const taskContext = makeRuntimeContext(
      record.context.resolver,
      record.childScope,
      [],
      record.signalLink.signal,
      record.context,
      record.context.executionId,
      record.context.executor
    )
    const classify = (value: ResultType<EffectSuccess<Input>, EffectError<Input>>): ScopeOutcome =>
      record.handle.isInterrupted()
        ? {
            status: 'failure',
            cause: record.handle.interruptionReason(record.signalLink.signal)
          }
        : classifyRuntimeOutcome(value)

    let exit: ScopedTaskExit<EffectSuccess<Input>, EffectError<Input>>
    let result: ResultType<EffectSuccess<Input>, EffectError<Input>> | undefined

    try {
      if (record.handle.isInterrupted()) {
        await record.childScope.close({
          status: 'failure',
          cause: record.handle.interruptionReason(record.signalLink.signal)
        })
        exit = withCleanupFailure(
          {
            status: 'interrupted' as const,
            reason: record.handle.interruptionReason(record.signalLink.signal)
          },
          cleanupFailure
        )
      } else {
        const childResult = await runScoped(record.childScope, () => record.program(), {
          classify,
          onCleanupFailure: onChildCleanupFailure,
          contextStorage: record.storage,
          context: taskContext
        })
        result = childResult

        if (record.handle.isInterrupted()) {
          exit = withCleanupFailure(
            {
              status: 'interrupted' as const,
              reason: record.handle.interruptionReason(record.signalLink.signal)
            },
            cleanupFailure
          )
        } else if (childResult instanceof Err) {
          exit = withCleanupFailure(
            {
              status: 'failed' as const,
              error: childResult.error
            },
            cleanupFailure
          )
        } else {
          exit = withCleanupFailure(
            {
              status: 'succeeded' as const,
              value: childResult.value
            },
            cleanupFailure
          )
        }
      }
    } catch (cause) {
      exit = record.handle.isInterrupted()
        ? withCleanupFailure(
            {
              status: 'interrupted' as const,
              reason: record.handle.interruptionReason(record.signalLink.signal)
            },
            cleanupFailure
          )
        : withCleanupFailure(
            {
              status: 'defected' as const,
              cause
            },
            cleanupFailure
          )
    }

    record.signalLink.signal.removeEventListener('abort', onAbort)
    record.signalLink.dispose()
    record.handle.settle(exit, result)
    this.tasks.delete(record.metadata.taskId)
    this.notifyEnd(record.metadata, exit)
  }
}
