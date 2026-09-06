// oxlint-disable anti-slop/no-runtime-typeof -- cadence inputs are untrusted public boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- validators intentionally accept untyped values.

import { JobDefinitionError } from '../protocol'

const invalid = (field: string, message: string): never => {
  throw new JobDefinitionError({ field, message })
}

const checkedEpoch = (value: unknown, field: string): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 8_640_000_000_000_000
  ) {
    return invalid(field, 'must be a non-negative safe integer epoch millisecond')
  }

  return value
}

/** Validate and retain a positive, safe millisecond cadence. */
export const makeEveryMs = (value: unknown): number => {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 8_640_000_000_000_000
  ) {
    return invalid('everyMs', 'must be a positive safe integer duration')
  }

  return value
}

/** The first tick is one cadence after creation; this value is the grade anchor. */
export const firstEveryMsOccurrence = (everyMs: number, nowMs: number): number => {
  const cadence = makeEveryMs(everyMs)
  const now = checkedEpoch(nowMs, 'nowMs')
  const first = now + cadence

  if (!Number.isSafeInteger(first) || first > 8_640_000_000_000_000) {
    return invalid('everyMs', 'first occurrence exceeds the supported epoch range')
  }

  return first
}

/**
 * Return the next grade slot strictly after `afterMs`.
 * `anchorMs` is the first persisted slot, so redeploying a definition does not
 * silently move the cadence to a new wall-clock origin.
 */
export const nextEveryMsOccurrence = (
  everyMs: number,
  afterMs: number,
  anchorMs: number
): number => {
  const cadence = makeEveryMs(everyMs)
  const after = checkedEpoch(afterMs, 'afterMs')
  const anchor = checkedEpoch(anchorMs, 'anchorMs')

  if (anchor > after) {
    return anchor
  }

  const elapsed = after - anchor
  const intervals = Math.floor(elapsed / cadence) + 1
  const next = anchor + intervals * cadence

  if (!Number.isSafeInteger(next) || next > 8_640_000_000_000_000) {
    return invalid('everyMs', 'next occurrence exceeds the supported epoch range')
  }

  return next
}
