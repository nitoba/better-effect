// oxlint-disable anti-slop/no-unknown-parameters -- codec errors sanitize arbitrary values at an untyped boundary.

import { TaggedError } from 'better-result'

import { hasTaggedError } from '../internal/tagged'

type TaggedErrorConstructor = abstract new (...args: never[]) => object

type ReadDataPropertyResult = {
  readonly present: boolean
  readonly value: unknown
}

type MutableCodecIssue = {
  message: string
  path?: CodecPath
  code?: string
}

type MutableCodecFailureOptions = {
  message: string
  path?: CodecPath
  code?: string
  issues?: ReadonlyArray<CodecIssue>
}

type SanitizedCodecFailureOptions = {
  readonly message: string
  readonly path?: CodecPath
  readonly code?: string
  readonly issues?: ReadonlyArray<CodecIssue>
}

type SafeCodecJson<Tag extends string> = {
  _tag: Tag
  message: string
  path?: CodecPath
  code?: string
  issues?: ReadonlyArray<CodecIssue>
}

export type CodecPathSegment = string | number

export type CodecPath = readonly CodecPathSegment[]

/** A bounded, JSON-safe validation diagnostic. */
export type CodecIssue = {
  readonly message: string
  readonly path?: CodecPath
  readonly code?: string
}

export type JobCodecFailureOptions = {
  readonly message?: string
  readonly path?: CodecPath
  readonly code?: string
  readonly issues?: readonly CodecIssue[]
}

const maxMessageLength = 256
const maxCodeLength = 64
const maxIssueCount = 32
const maxPathLength = 64

const readDataProperty = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- error constructors defensively inspect JavaScript caller input.
  value: unknown,
  key: string
): ReadDataPropertyResult => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- error options may come from untyped JavaScript callers.
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { present: false, value: undefined }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)

    if (descriptor === undefined || !('value' in descriptor)) {
      return { present: false, value: undefined }
    }

    return { present: true, value: descriptor.value }
  } catch {
    return { present: false, value: undefined }
  }
}

const safeText = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- values are narrowed before entering the error representation.
  value: unknown,
  fallback: string,
  limit: number
): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- arbitrary error data must never be coerced with String().
  if (typeof value !== 'string' || value.length === 0) {
    return fallback
  }

  // eslint-disable-next-line no-control-regex -- control characters are intentionally redacted from diagnostics.
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ')

  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`
}

const sanitizePathSegment = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- path segments originate in untrusted schema diagnostics.
  value: unknown
): CodecPathSegment | undefined => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- only JSON-safe path segments are retained.
  if (typeof value === 'string') {
    return safeText(value, 'path', 128)
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- only JSON-safe path segments are retained.
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return Object.is(value, -0) ? 0 : value
  }

  const key = readDataProperty(value, 'key')

  if (!key.present) {
    return undefined
  }

  // Standard Schema path wrappers contain one primitive `key`; nested wrappers are rejected.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- only JSON-safe path segments are retained.
  if (typeof key.value === 'string') {
    return safeText(key.value, 'path', 128)
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- only JSON-safe path segments are retained.
  if (typeof key.value === 'number' && Number.isSafeInteger(key.value)) {
    return Object.is(key.value, -0) ? 0 : key.value
  }

  return undefined
}

const sanitizePath = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- paths originate in untrusted schema diagnostics.
  value: unknown
): CodecPath | undefined => {
  let pathValue: readonly unknown[]

  try {
    if (!Array.isArray(value)) {
      return undefined
    }

    pathValue = value
  } catch {
    return undefined
  }

  const path: CodecPathSegment[] = []

  try {
    for (let index = 0; index < pathValue.length && index < maxPathLength; index += 1) {
      const segment = readDataProperty(pathValue, String(index))
      const safeSegment = sanitizePathSegment(segment.value)

      if (!segment.present || safeSegment === undefined) {
        break
      }

      path.push(safeSegment)
    }
  } catch {
    return path.length === 0 ? undefined : Object.freeze(path)
  }

  return Object.freeze(path)
}

const sanitizeIssue = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- schema issue values are untrusted.
  value: unknown
): CodecIssue => {
  const code = readDataProperty(value, 'code')
  const path = readDataProperty(value, 'path')
  const issue: MutableCodecIssue = {
    // Validator messages can echo the rejected value, so only retain a fixed safe diagnostic.
    message: 'Validation failed'
  }
  const safeCode = safeText(code.value, '', maxCodeLength)
  const safePath = sanitizePath(path.value)

  if (safeCode !== '') {
    issue.code = safeCode
  }

  if (safePath !== undefined) {
    issue.path = safePath
  }

  return Object.freeze(issue)
}

const sanitizeIssues = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- issues are supplied by untrusted validators.
  value: unknown
): ReadonlyArray<CodecIssue> | undefined => {
  let issueValues: readonly unknown[]

  try {
    if (!Array.isArray(value)) {
      return undefined
    }

    issueValues = value
  } catch {
    return undefined
  }

  const issues: CodecIssue[] = []

  try {
    for (let index = 0; index < issueValues.length && index < maxIssueCount; index += 1) {
      issues.push(sanitizeIssue(readDataProperty(issueValues, String(index)).value))
    }
  } catch {
    return issues.length === 0 ? undefined : Object.freeze(issues)
  }

  return Object.freeze(issues)
}

const sanitizeOptions = (args: JobCodecFailureOptions): SanitizedCodecFailureOptions => {
  const message = readDataProperty(args, 'message')
  const code = readDataProperty(args, 'code')
  const path = readDataProperty(args, 'path')
  const issues = readDataProperty(args, 'issues')
  const safeMessage = safeText(message.value, 'Job codec operation failed', maxMessageLength)
  const safeCode = safeText(code.value, '', maxCodeLength)
  const safePath = sanitizePath(path.value)
  const safeIssues = sanitizeIssues(issues.value)
  const result: MutableCodecFailureOptions = { message: safeMessage }

  if (safePath !== undefined) {
    result.path = safePath
  }

  if (safeCode !== '') {
    result.code = safeCode
  }

  if (safeIssues !== undefined) {
    result.issues = safeIssues
  }

  return result
}

const toSafeJson = <Tag extends string>(
  tag: Tag,
  message: string,
  path: CodecPath | undefined,
  code: string | undefined,
  issues: ReadonlyArray<CodecIssue> | undefined
): object => {
  const result: SafeCodecJson<Tag> = { _tag: tag, message }

  if (path !== undefined) {
    result.path = path
  }

  if (code !== undefined) {
    result.code = code
  }

  if (issues !== undefined) {
    result.issues = issues
  }

  return Object.freeze(result)
}

/** A safe failure produced while converting an in-memory value to JSON. */
export class JobEncodeFailure extends TaggedError('JobEncodeFailure')<{
  readonly message: string
  readonly path?: CodecPath
  readonly code?: string
  readonly issues?: ReadonlyArray<CodecIssue>
}> {
  constructor(args: JobCodecFailureOptions = {}) {
    super(sanitizeOptions(args))
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- guards accept arbitrary cross-package values.
  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobEncodeFailure')
  }

  override toJSON(): object {
    return toSafeJson(this._tag, this.message, this.path, this.code, this.issues)
  }
}

/** A safe failure produced while validating or converting persisted JSON. */
export class JobDecodeFailure extends TaggedError('JobDecodeFailure')<{
  readonly message: string
  readonly path?: CodecPath
  readonly code?: string
  readonly issues?: ReadonlyArray<CodecIssue>
}> {
  constructor(args: JobCodecFailureOptions = {}) {
    super(sanitizeOptions(args))
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- guards accept arbitrary cross-package values.
  static override is<C extends TaggedErrorConstructor>(
    this: C,
    value: unknown
  ): value is InstanceType<C> {
    return hasTaggedError(value, 'JobDecodeFailure')
  }

  override toJSON(): object {
    return toSafeJson(this._tag, this.message, this.path, this.code, this.issues)
  }
}

export const copyEncodeFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a returned error may come from a duplicated package instance.
  value: unknown,
  fallback = 'Job codec encode operation failed'
): JobEncodeFailure => {
  const message = readDataProperty(value, 'message')
  const path = readDataProperty(value, 'path')
  const code = readDataProperty(value, 'code')
  const issues = readDataProperty(value, 'issues')

  const options: MutableCodecFailureOptions = {
    message: safeText(message.value, fallback, maxMessageLength)
  }
  const safePath = sanitizePath(path.value)
  const safeCode = safeText(code.value, '', maxCodeLength)
  const safeIssues = sanitizeIssues(issues.value)

  if (safePath !== undefined) {
    options.path = safePath
  }

  if (safeCode !== '') {
    options.code = safeCode
  }

  if (safeIssues !== undefined) {
    options.issues = safeIssues
  }

  return new JobEncodeFailure(options)
}

export const copyDecodeFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a returned error may come from a duplicated package instance.
  value: unknown,
  fallback = 'Job codec decode operation failed'
): JobDecodeFailure => {
  const message = readDataProperty(value, 'message')
  const path = readDataProperty(value, 'path')
  const code = readDataProperty(value, 'code')
  const issues = readDataProperty(value, 'issues')

  const options: MutableCodecFailureOptions = {
    message: safeText(message.value, fallback, maxMessageLength)
  }
  const safePath = sanitizePath(path.value)
  const safeCode = safeText(code.value, '', maxCodeLength)
  const safeIssues = sanitizeIssues(issues.value)

  if (safePath !== undefined) {
    options.path = safePath
  }

  if (safeCode !== '') {
    options.code = safeCode
  }

  if (safeIssues !== undefined) {
    options.issues = safeIssues
  }

  return new JobDecodeFailure(options)
}

export const sanitizeSchemaIssues = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema issues are an untrusted validator boundary.
  value: unknown
): ReadonlyArray<CodecIssue> => sanitizeIssues(value) ?? Object.freeze([])
