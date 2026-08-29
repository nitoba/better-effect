import { Err } from 'better-result'

import type { Result as ResultType } from 'better-result'

type AnyResult = ResultType<any, any>

export type ProgramCollectionFailure =
  | { readonly kind: 'result'; readonly result: AnyResult }
  | { readonly kind: 'defect'; readonly cause: unknown }

export type ProgramCollectionOutcome = {
  readonly results: Array<AnyResult | undefined>
  readonly failures: Array<ProgramCollectionFailure | undefined>
}

export type ProgramCollectionOptions = {
  readonly concurrency: number | undefined
  readonly stopOnResultError: boolean
}

type ProgramTask = (index: number) => AnyResult | PromiseLike<AnyResult>

type SchedulerState = {
  nextIndex: number
  stopScheduling: boolean
  readonly results: Array<AnyResult | undefined>
  readonly failures: Array<ProgramCollectionFailure | undefined>
}

/** Validate the shared bounded-concurrency option before a Program is run. */
export const validateProgramConcurrency = (concurrency: number | undefined): void => {
  if (
    concurrency !== undefined &&
    (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency <= 0)
  ) {
    throw new RangeError('Program.all concurrency must be a positive integer')
  }
}

const runWorker = async (
  length: number,
  task: ProgramTask,
  stopOnResultError: boolean,
  state: SchedulerState
): Promise<void> => {
  while (!state.stopScheduling) {
    const index = state.nextIndex++

    if (index >= length) {
      return
    }

    try {
      const result = await task(index)
      state.results[index] = result

      if (result instanceof Err) {
        state.failures[index] = { kind: 'result', result }
        state.stopScheduling ||= stopOnResultError
      }
    } catch (cause) {
      state.failures[index] = { kind: 'defect', cause }
      state.stopScheduling = true
    }
  }
}

/** Run claimed Programs with a shared FIFO worker pool and no cancellation. */
export const runProgramCollection = async (
  length: number,
  task: ProgramTask,
  options: ProgramCollectionOptions
): Promise<ProgramCollectionOutcome> => {
  const state: SchedulerState = {
    nextIndex: 0,
    stopScheduling: false,
    results: Array.from({ length }),
    failures: Array.from({ length })
  }
  const workerCount = Math.min(options.concurrency ?? length, length)
  const workers = Array.from({ length: workerCount }, () =>
    runWorker(length, task, options.stopOnResultError, state)
  )

  await Promise.all(workers)

  return state
}

/** Select the first failure by input index, independent of settlement order. */
export const firstProgramFailure = (
  failures: readonly (ProgramCollectionFailure | undefined)[]
): ProgramCollectionFailure | undefined => {
  for (const failure of failures) {
    if (failure !== undefined) {
      return failure
    }
  }

  return undefined
}
