import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError } from './errors'
import { validateJobRecord } from './records'
import type { JobRecord } from './types'

const compareAscending = (left: number, right: number): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const utf8Encoder = new TextEncoder()

/** Compare UTF-8 bytes as unsigned values, with a shorter prefix first. */
const compareJobIds = (left: string, right: string): number => {
  const leftBytes = utf8Encoder.encode(left)
  const rightBytes = utf8Encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)

  for (let index = 0; index < length; index += 1) {
    const comparison = compareAscending(leftBytes[index] ?? 0, rightBytes[index] ?? 0)

    if (comparison !== 0) return comparison
  }

  return compareAscending(leftBytes.length, rightBytes.length)
}

/**
 * Compare two claim candidates by the durable protocol order:
 * priority descending, runAt ascending, insertion sequence ascending, then id.
 */
export const compareJobOrder = (left: JobRecord, right: JobRecord): number => {
  const priority = compareAscending(right.priority, left.priority)

  if (priority !== 0) return priority

  const runAt = compareAscending(left.runAt, right.runAt)

  if (runAt !== 0) return runAt

  const sequence = compareAscending(left.orderingSequence, right.orderingSequence)

  if (sequence !== 0) return sequence

  return compareJobIds(left.id, right.id)
}

/** Validate and return a new immutable array in deterministic claim order. */
export const orderJobs = (
  jobs: readonly JobRecord[]
): ResultType<readonly JobRecord[], JobDefinitionError> => {
  try {
    const validated: JobRecord[] = []

    for (const job of jobs) {
      const checked = validateJobRecord(job)

      if (Result.isError(checked)) {
        return Result.err(checked.error)
      }

      validated.push(checked.value)
    }

    validated.sort(compareJobOrder)

    return Result.ok(Object.freeze(validated))
  } catch {
    return Result.err(new JobDefinitionError({ field: 'jobs', message: 'could not read jobs' }))
  }
}

export const sortClaimCandidates = orderJobs
