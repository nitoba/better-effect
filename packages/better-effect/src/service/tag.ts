const serviceTags = new WeakMap<object, string>()

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This boundary validates untrusted JavaScript token values.
const isObjectLike = (value: unknown): value is object => value !== null && Object(value) === value

// oxlint-disable-next-line anti-slop/no-object-parameters -- Tokens are validated object-like owners at this internal boundary.
const lockServiceTag = (token: object, tag: string): void => {
  const descriptor = Object.getOwnPropertyDescriptor(token, 'serviceTag')

  if (descriptor?.configurable === false) {
    if ('value' in descriptor && descriptor.value === tag && descriptor.writable === false) {
      return
    }

    if ('value' in descriptor && descriptor.value === tag && descriptor.writable === true) {
      Object.defineProperty(token, 'serviceTag', { writable: false })
      return
    }

    throw new TypeError('Service tags must be immutable')
  }

  Object.defineProperty(token, 'serviceTag', {
    value: tag,
    writable: false,
    enumerable: descriptor?.enumerable ?? true,
    configurable: false
  })
}

/** Validate the runtime form of a Service tag without coercing it. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate the public JavaScript declaration boundary.
export const validateServiceTag = (tag: unknown): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject boxed and object tag aliases instead of coercing them.
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new TypeError('Service tags must be non-empty primitive strings')
  }

  return tag
}

/** Record a declaration tag and make the public static property immutable. */
// oxlint-disable-next-line anti-slop/no-object-parameters -- The declaration owner is always a class constructor.
export const registerServiceTag = (token: object, tag: string): void => {
  const canonicalTag = validateServiceTag(tag)
  const existing = serviceTags.get(token)

  if (existing !== undefined) {
    if (existing !== canonicalTag) {
      throw new TypeError('A Service tag cannot be changed after declaration')
    }

    return
  }

  lockServiceTag(token, canonicalTag)
  serviceTags.set(token, canonicalTag)
}

/** Capture a token's logical tag once so later mutable aliases cannot drift. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate unchecked Service tokens at each runtime boundary.
export const captureServiceTag = (token: unknown): string => {
  if (!isObjectLike(token)) {
    throw new TypeError('Service tokens must be objects or functions')
  }

  const known = serviceTags.get(token)

  if (known !== undefined) {
    return known
  }

  let prototype = Object.getPrototypeOf(token)

  while (isObjectLike(prototype)) {
    const inherited = serviceTags.get(prototype)

    if (inherited !== undefined) {
      lockServiceTag(token, inherited)
      serviceTags.set(token, inherited)

      return inherited
    }

    prototype = Object.getPrototypeOf(prototype)
  }

  // SAFETY: The object-like check above limits this assertion to a token-shaped object; the value is validated immediately below.
  const tag = validateServiceTag((token as { readonly serviceTag?: unknown }).serviceTag)
  lockServiceTag(token, tag)
  serviceTags.set(token, tag)

  return tag
}
