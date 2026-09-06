// oxlint-disable anti-slop/no-runtime-typeof -- cron and timezone inputs are untrusted public boundaries.
// oxlint-disable anti-slop/no-unknown-parameters -- parser inputs are intentionally untyped at runtime.

import { JobDefinitionError } from '../protocol'

type CronField = {
  readonly values: ReadonlySet<number>
  readonly wildcard: boolean
}

export type ParsedCronExpression = {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

export type CronExpression = ParsedCronExpression

type CronFieldRange = {
  readonly min: number
  readonly max: number
  readonly dayOfWeek: boolean
}

type ZonedParts = {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const minuteRange = { min: 0, max: 59, dayOfWeek: false } as const
const hourRange = { min: 0, max: 23, dayOfWeek: false } as const
const dayOfMonthRange = { min: 1, max: 31, dayOfWeek: false } as const
const monthRange = { min: 1, max: 12, dayOfWeek: false } as const
const dayOfWeekRange = { min: 0, max: 7, dayOfWeek: true } as const

const maxSearchMinutes = 8 * 366 * 24 * 60
const hourMs = 60 * 60 * 1_000
const dayMs = 24 * hourMs

const invalidCron = (message: string): never => {
  throw new JobDefinitionError({ field: 'cron', message })
}

const readNumber = (value: string, range: CronFieldRange): number => {
  if (!/^\d+$/.test(value)) {
    invalidCron('cron fields must contain decimal integers')
  }

  const number = Number(value)

  if (!Number.isSafeInteger(number) || number < range.min || number > range.max) {
    invalidCron(`cron value must be between ${range.min} and ${range.max}`)
  }

  return number
}

const normalizeValue = (value: number, range: CronFieldRange): number =>
  range.dayOfWeek && value === 7 ? 0 : value

const parseField = (value: string, range: CronFieldRange): CronField => {
  if (value.length === 0) {
    invalidCron('cron fields must not be empty')
  }

  const values = new Set<number>()
  let hasWildcard = false

  for (const listItem of value.split(',')) {
    if (listItem.length === 0) {
      invalidCron('cron lists must not contain empty items')
    }

    const stepParts = listItem.split('/')

    if (stepParts.length > 2) {
      invalidCron('cron steps may contain only one slash')
    }

    const base = stepParts[0]
    if (base === undefined || base.length === 0) {
      return invalidCron('cron steps require a base expression')
    }

    let step = 1
    if (stepParts.length === 2) {
      const stepValue = stepParts[1]
      if (stepValue === undefined || !/^\d+$/.test(stepValue)) {
        invalidCron('cron steps must be positive decimal integers')
      }
      step = Number(stepValue)
      if (!Number.isSafeInteger(step) || step < 1) {
        invalidCron('cron steps must be positive safe integers')
      }
    }

    let start: number
    let end: number

    if (base === '*') {
      hasWildcard = true
      start = range.min
      end = range.max
    } else {
      const rangeParts = base.split('-')
      if (rangeParts.length > 2) {
        invalidCron('cron ranges may contain only one hyphen')
      }

      start = readNumber(rangeParts[0] ?? '', range)
      end = rangeParts.length === 2 ? readNumber(rangeParts[1] ?? '', range) : range.max

      if (rangeParts.length === 2 && start > end) {
        invalidCron('cron range start must not be greater than its end')
      }

      if (rangeParts.length === 1 && stepParts.length === 1) {
        end = start
      }
    }

    for (let current = start; current <= end; current += step) {
      values.add(normalizeValue(current, range))
    }
  }

  return Object.freeze({
    values,
    wildcard: hasWildcard
  })
}

export const parseCronExpression = (cron: string): ParsedCronExpression => {
  if (typeof cron !== 'string') {
    invalidCron('must be a five-field string')
  }

  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
    invalidCron('must contain exactly five fields: minute hour day-of-month month day-of-week')
  }

  return Object.freeze({
    minute: parseField(fields[0] ?? '', minuteRange),
    hour: parseField(fields[1] ?? '', hourRange),
    dayOfMonth: parseField(fields[2] ?? '', dayOfMonthRange),
    month: parseField(fields[3] ?? '', monthRange),
    dayOfWeek: parseField(fields[4] ?? '', dayOfWeekRange)
  })
}

export const parseCron = parseCronExpression

export const isValidTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0) {
    return false
  }

  try {
    makeFormatter(value)
    return true
  } catch {
    return false
  }
}

export const normalizeTimeZone = (value: unknown, field = 'timeZone'): string => {
  if (value === undefined) {
    return 'UTC'
  }

  if (!isValidTimeZone(value)) {
    throw new JobDefinitionError({ field, message: 'must be a valid IANA timezone' })
  }

  return value
}

const makeFormatter = (timeZone: string | undefined): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone ?? 'UTC',
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
  } catch {
    throw new JobDefinitionError({ field: 'timeZone', message: 'must be a valid IANA timezone' })
  }
}

export const validateTimeZone = (timeZone: string): void => {
  makeFormatter(timeZone)
}

const formatZonedParts = (formatter: Intl.DateTimeFormat, epochMs: number): ZonedParts => {
  const parts = formatter.formatToParts(new Date(epochMs))
  const values = new Map<string, number>()

  for (const part of parts) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values.set(part.type, Number(part.value))
    } else if (part.type === 'hour' || part.type === 'minute' || part.type === 'second') {
      values.set(part.type, Number(part.value))
    }
  }

  const year = values.get('year')
  const month = values.get('month')
  const day = values.get('day')
  const hour = values.get('hour')
  const minute = values.get('minute')
  const second = values.get('second')

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    throw new JobDefinitionError({ field: 'timeZone', message: 'could not read calendar fields' })
  }

  return { year, month, day, hour, minute, second }
}

const civilEpoch = (parts: ZonedParts): number => {
  const date = new Date(0)
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0)
  const epochMs = date.getTime()

  if (!Number.isSafeInteger(epochMs)) {
    throw new JobDefinitionError({ field: 'cron', message: 'calendar value is outside date range' })
  }

  return epochMs
}

const sameParts = (left: ZonedParts, right: ZonedParts): boolean =>
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  left.hour === right.hour &&
  left.minute === right.minute &&
  left.second === right.second

const resolveLocalEpochs = (
  formatter: Intl.DateTimeFormat,
  target: ZonedParts,
  wallEpochMs: number
): readonly number[] => {
  const candidates = new Set<number>()

  for (const seed of [
    wallEpochMs - 3 * dayMs,
    wallEpochMs - dayMs,
    wallEpochMs,
    wallEpochMs + dayMs,
    wallEpochMs + 3 * dayMs
  ]) {
    let candidate = seed

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = formatZonedParts(formatter, candidate)
      const offset = civilEpoch(current) - candidate
      const next = wallEpochMs - offset

      if (!Number.isSafeInteger(next)) {
        break
      }

      candidate = next
      if (sameParts(formatZonedParts(formatter, candidate), target)) {
        candidates.add(candidate)
        break
      }
    }
  }

  return [...candidates].sort((left, right) => left - right)
}

const cronMatches = (cron: ParsedCronExpression, parts: ZonedParts, dayOfWeek: number): boolean => {
  if (!cron.minute.values.has(parts.minute)) return false
  if (!cron.hour.values.has(parts.hour)) return false
  if (!cron.month.values.has(parts.month)) return false

  const dayOfMonthMatches = cron.dayOfMonth.values.has(parts.day)
  const dayOfWeekMatches = cron.dayOfWeek.values.has(dayOfWeek)

  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) {
    return true
  }
  if (cron.dayOfMonth.wildcard) {
    return dayOfWeekMatches
  }
  if (cron.dayOfWeek.wildcard) {
    return dayOfMonthMatches
  }

  return dayOfMonthMatches || dayOfWeekMatches
}

export const nextCronOccurrence = (cron: string, afterMs: number, timeZone?: string): number => {
  const parsed = parseCronExpression(cron)
  if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
    throw new JobDefinitionError({
      field: 'afterMs',
      message: 'must be a non-negative safe integer'
    })
  }

  const formatter = makeFormatter(timeZone)
  const afterParts = formatZonedParts(formatter, afterMs)
  let cursor = civilEpoch({ ...afterParts, second: 0 })

  for (let index = 0; index < maxSearchMinutes; index += 1) {
    const cursorDate = new Date(cursor)
    const parts: ZonedParts = {
      year: cursorDate.getUTCFullYear(),
      month: cursorDate.getUTCMonth() + 1,
      day: cursorDate.getUTCDate(),
      hour: cursorDate.getUTCHours(),
      minute: cursorDate.getUTCMinutes(),
      second: 0
    }
    const dayOfWeek = cursorDate.getUTCDay()

    if (cronMatches(parsed, parts, dayOfWeek)) {
      const wallEpochMs = civilEpoch(parts)
      const candidates = resolveLocalEpochs(formatter, parts, wallEpochMs)

      const earliest = candidates[0]

      if (earliest !== undefined && earliest > afterMs) {
        return earliest
      }
    }

    cursor += 60_000
  }

  throw new JobDefinitionError({ field: 'cron', message: 'no occurrence found in search horizon' })
}
