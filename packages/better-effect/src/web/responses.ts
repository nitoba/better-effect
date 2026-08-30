import type { WebEffectSuccess, WebJsonValue } from './types'

/* oxlint-disable anti-slop/no-object-parameters -- Web Response values are validated structurally at this boundary. */
/* oxlint-disable anti-slop/no-runtime-typeof -- Web Response and JSON values require runtime protocol validation. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Web Response and JSON policies accept opaque JavaScript values. */
/* oxlint-disable anti-slop/no-unknown-returns -- Web Response and JSON policies narrow opaque JavaScript values locally. */

const DEFAULT_FAILURE_MESSAGE = 'Internal Server Error'

type ResponseCandidate = {
  readonly body: unknown
  readonly bodyUsed: unknown
  readonly headers: unknown
  readonly ok: unknown
  readonly redirected: unknown
  readonly status: unknown
  readonly statusText: unknown
  readonly type: unknown
  readonly url: unknown
  readonly arrayBuffer: unknown
  readonly blob: unknown
  readonly clone: unknown
  readonly formData: unknown
  readonly json: unknown
  readonly text: unknown
}

/** An unsupported value encountered by the default Web JSON policy. */
export class WebEffectSerializationError extends TypeError {
  constructor(detail: string) {
    super(`WebEffect default success serialization ${detail}`)
    this.name = 'WebEffectSerializationError'
  }
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

const isCallable = (value: unknown): value is (...arguments_: never[]) => unknown =>
  typeof value === 'function'

type HeadersCandidate = {
  readonly get?: unknown
  readonly has?: unknown
  readonly forEach?: unknown
}

const isHeaders = (value: unknown): boolean => {
  if (!isObject(value)) {
    return false
  }

  // SAFETY: isObject above establishes the runtime object shape before structural field inspection.
  const candidate = value as HeadersCandidate

  return isCallable(candidate.get) && isCallable(candidate.has) && isCallable(candidate.forEach)
}

const isResponseStatus = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  (value === 0 || (value >= 200 && value <= 599))

const isResponseType = (value: unknown): value is Response['type'] =>
  value === 'basic' ||
  value === 'cors' ||
  value === 'default' ||
  value === 'error' ||
  value === 'opaque' ||
  value === 'opaqueredirect'

/** Accept native, cross-realm, and standards-compatible Web Response values. */
const isWebResponse = (value: unknown): value is Response => {
  if (!isObject(value)) {
    return false
  }

  try {
    // SAFETY: isObject above establishes the runtime object shape before structural field inspection.
    const candidate = value as ResponseCandidate

    const status = candidate.status

    if (!isResponseStatus(status)) {
      return false
    }

    return (
      (candidate.body === null || isObject(candidate.body)) &&
      typeof candidate.bodyUsed === 'boolean' &&
      isHeaders(candidate.headers) &&
      typeof candidate.ok === 'boolean' &&
      candidate.ok === (status >= 200 && status <= 299) &&
      typeof candidate.redirected === 'boolean' &&
      typeof candidate.statusText === 'string' &&
      isResponseType(candidate.type) &&
      typeof candidate.url === 'string' &&
      isCallable(candidate.arrayBuffer) &&
      isCallable(candidate.blob) &&
      isCallable(candidate.clone) &&
      isCallable(candidate.formData) &&
      isCallable(candidate.json) &&
      isCallable(candidate.text)
    )
  } catch {
    return false
  }
}

const propertyPath = (path: string, property: string): string => `${path}.${property}`

const unsupported = (path: string, kind: string): never => {
  throw new WebEffectSerializationError(`cannot encode ${kind} at ${path}`)
}

const ownDataProperties = (
  value: object,
  path: string
): readonly (readonly [string, unknown])[] => {
  const symbols = Object.getOwnPropertySymbols(value)

  if (symbols.length > 0) {
    unsupported(path, 'symbol-keyed properties')
  }

  return Object.getOwnPropertyNames(value).map((property) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, property)

    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      unsupported(propertyPath(path, property), 'non-enumerable or accessor properties')
    }

    // SAFETY: the preceding descriptor guard establishes a data descriptor with an enumerable value.
    const dataDescriptor = descriptor as PropertyDescriptor & { readonly value: unknown }

    return [property, dataDescriptor.value] as const
  })
}

const arrayIndex = (property: string): number | undefined => {
  const index = Number(property)

  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === property
    ? index
    : undefined
}

const sanitizeArray = (
  value: readonly unknown[],
  path: string,
  ancestors: Set<object>
): readonly WebJsonValue[] => {
  const symbols = Object.getOwnPropertySymbols(value)

  if (symbols.length > 0) {
    unsupported(path, 'symbol-keyed properties')
  }

  const properties = Object.getOwnPropertyNames(value)

  if (properties.length !== value.length + 1 || !properties.includes('length')) {
    unsupported(path, 'sparse or augmented arrays')
  }

  const output: WebJsonValue[] = []

  for (let index = 0; index < value.length; index += 1) {
    const property = String(index)
    const descriptor = Object.getOwnPropertyDescriptor(value, property)

    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true ||
      arrayIndex(property) === undefined
    ) {
      unsupported(propertyPath(path, property), 'sparse or accessor array elements')
    }

    // SAFETY: the preceding descriptor guard establishes a data descriptor with an enumerable value.
    const dataDescriptor = descriptor as PropertyDescriptor & { readonly value: unknown }

    output.push(sanitizeJsonValue(dataDescriptor.value, propertyPath(path, property), ancestors))
  }

  return output
}

const sanitizeObject = (
  value: object,
  path: string,
  ancestors: Set<object>
): { readonly [key: string]: WebJsonValue } => {
  const prototype = Object.getPrototypeOf(value)

  if (prototype !== Object.prototype && prototype !== null) {
    unsupported(path, 'non-plain objects')
  }

  // SAFETY: Object.create(null) is an empty dictionary that is populated only with sanitized values.
  const output: { [key: string]: WebJsonValue } = Object.create(null) as {
    [key: string]: WebJsonValue
  }

  for (const [property, child] of ownDataProperties(value, path)) {
    output[property] = sanitizeJsonValue(child, propertyPath(path, property), ancestors)
  }

  return output
}

const sanitizeJsonValue = (
  value: unknown,
  path: string,
  ancestors: Set<object> = new Set()
): WebJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : unsupported(path, 'non-finite numbers')
  }

  if (typeof value === 'undefined') {
    return unsupported(path, 'undefined values')
  }

  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return unsupported(path, `${typeof value} values`)
  }

  if (!isObject(value)) {
    return unsupported(path, 'unsupported values')
  }

  if (ancestors.has(value)) {
    return unsupported(path, 'circular values')
  }

  ancestors.add(value)

  try {
    return Array.isArray(value)
      ? sanitizeArray(value, path, ancestors)
      : sanitizeObject(value, path, ancestors)
  } finally {
    ancestors.delete(value)
  }
}

/** Convert a successful value using the boundary's constrained JSON policy. */
export const defaultSuccess = ({ value }: WebEffectSuccess): Response => {
  if (isWebResponse(value)) {
    return value
  }

  if (value === undefined) {
    return new Response(null, { status: 204 })
  }

  return Response.json({ data: sanitizeJsonValue(value, '$') })
}

/** Redact typed failures unless the failure is an intentional Response. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Typed Result errors are intentionally opaque at this HTTP boundary.
export const defaultFailure = (error: unknown): Response => {
  if (isWebResponse(error)) {
    return error
  }

  return Response.json({ error: DEFAULT_FAILURE_MESSAGE }, { status: 500 })
}

/** Validate policy output at the JavaScript boundary before returning it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Policy callbacks are opaque JavaScript inputs at this boundary.
export const assertResponse = (response: unknown): Response => {
  if (!isWebResponse(response)) {
    throw new TypeError('WebEffect response policies must return a Response')
  }

  return response
}
