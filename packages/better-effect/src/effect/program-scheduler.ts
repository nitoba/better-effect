import { Err } from 'better-result'

import type { Result as ResultType } from 'better-result'

type AnyResult = ResultType<any, any>

type ProgramCollectionFailure =
  | { readonly kind: 'result'; readonly result: AnyResult }
  | { readonly kind: 'defect'; readonly cause: unknown }

type ProgramCollectionDefect = { readonly cause: unknown }

type ProgramCollectionOutcome = {
  readonly results: Array<AnyResult | undefined>
  readonly defects: Array<ProgramCollectionDefect | undefined>
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
  readonly defects: Array<ProgramCollectionDefect | undefined>
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
        state.stopScheduling ||= stopOnResultError
      }
    } catch (cause) {
      state.defects[index] = { cause }
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
    defects: Array.from({ length })
  }
  const workerCount = Math.min(options.concurrency ?? length, length)
  const workers = Array.from({ length: workerCount }, () =>
    runWorker(length, task, options.stopOnResultError, state)
  )

  await Promise.all(workers)

  return state
}

/** Select the first defect by input index, independent of settlement order. */
export const firstProgramDefect = (
  defects: readonly (ProgramCollectionDefect | undefined)[]
): ProgramCollectionDefect | undefined => {
  for (const defect of defects) {
    if (defect !== undefined) {
      return defect
    }
  }

  return undefined
}

/** Select the first short-circuiting failure by input index. */
export const firstProgramFailure = (
  results: readonly (AnyResult | undefined)[],
  defects: readonly (ProgramCollectionDefect | undefined)[]
): ProgramCollectionFailure | undefined => {
  const length = Math.max(results.length, defects.length)

  for (let index = 0; index < length; index++) {
    const defect = defects[index]
    if (defect !== undefined) {
      return { kind: 'defect', cause: defect.cause }
    }

    const result = results[index]
    if (result instanceof Err) {
      return { kind: 'result', result }
    }
  }

  return undefined
}
