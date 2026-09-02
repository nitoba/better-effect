import type * as z from "zod"

export type SchemaIssuePathSegment = string | number
export type SchemaIssuePath = readonly SchemaIssuePathSegment[]

/** A bounded, serialization-safe validation issue. */
export interface SchemaIssue {
  readonly message: "Validation failed"
  readonly code?: string
  readonly path?: SchemaIssuePath
}

interface DataProperty {
  readonly present: boolean
  readonly value: unknown
}

interface MutableSchemaIssue {
  message: "Validation failed"
  code?: string
  path?: SchemaIssuePath
}

const MAX_ISSUES = 32
const MAX_CODE_LENGTH = 64
const MAX_PATH_LENGTH = 64
const MAX_PATH_SEGMENT_LENGTH = 128
const MAX_IDENTIFIER_LENGTH = 160

const readDataProperty = (value: unknown, key: PropertyKey): DataProperty => {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return { present: false, value: undefined }
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor)) {
      return { present: false, value: undefined }
    }

    return { present: true, value: descriptor.value }
  } catch {
    return { present: false, value: undefined }
  }
}

const sanitizeText = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined

  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ")
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1))}…`
}

const sanitizePathSegment = (value: unknown): SchemaIssuePathSegment | undefined => {
  if (typeof value === "string") {
    return sanitizeText(value, MAX_PATH_SEGMENT_LENGTH)
  }

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return Object.is(value, -0) ? 0 : value
  }

  const key = readDataProperty(value, "key")
  if (!key.present) return undefined

  if (typeof key.value === "string") {
    return sanitizeText(key.value, MAX_PATH_SEGMENT_LENGTH)
  }

  if (typeof key.value === "number" && Number.isSafeInteger(key.value)) {
    return Object.is(key.value, -0) ? 0 : key.value
  }

  return undefined
}

const sanitizePath = (value: unknown): SchemaIssuePath | undefined => {
  if (!Array.isArray(value)) return undefined

  const path: SchemaIssuePathSegment[] = []
  const length = Math.min(value.length, MAX_PATH_LENGTH)

  for (let index = 0; index < length; index += 1) {
    const segment = sanitizePathSegment(value[index])
    if (segment === undefined) break
    path.push(segment)
  }

  return path.length === 0 ? undefined : Object.freeze(path)
}

const sanitizeIssue = (value: unknown): SchemaIssue => {
  const code = readDataProperty(value, "code")
  const path = readDataProperty(value, "path")
  const issue: MutableSchemaIssue = { message: "Validation failed" }
  const safeCode = sanitizeText(code.value, MAX_CODE_LENGTH)
  const safePath = sanitizePath(path.value)

  if (safeCode !== undefined) issue.code = safeCode
  if (safePath !== undefined) issue.path = safePath

  return Object.freeze(issue)
}

/** Convert a Zod issue collection to a bounded, safe representation. */
export const sanitizeSchemaIssues = (error: z.ZodError): readonly SchemaIssue[] => {
  const issues = readDataProperty(error, "issues")
  if (!issues.present || !Array.isArray(issues.value)) {
    return Object.freeze([{ message: "Validation failed" }] satisfies SchemaIssue[])
  }

  const result: SchemaIssue[] = []
  const length = Math.min(issues.value.length, MAX_ISSUES)

  for (let index = 0; index < length; index += 1) {
    result.push(sanitizeIssue(issues.value[index]))
  }

  if (result.length === 0) result.push(Object.freeze({ message: "Validation failed" }))
  return Object.freeze(result)
}

/** Sanitize a diagnostic identifier without exposing arbitrary control text. */
export const sanitizeSchemaIdentifier = (identifier: string): string =>
  sanitizeText(identifier, MAX_IDENTIFIER_LENGTH) ?? "ZodSchema"
