/**
 * Carries already-decoded properties through a concrete JavaScript
 * constructor call.
 *
 * The context is intentionally keyed by both the concrete constructor and the
 * exact first argument. A user-defined constructor can therefore forward the
 * props with `super(props)` without also forwarding an internal options token,
 * while unrelated nested constructions remain independently validated.
 */
interface ConstructionContext {
  readonly input: unknown
  readonly props: Record<PropertyKey, unknown>
}

const contexts = new WeakMap<Function, ConstructionContext[]>()

export const enterPrevalidatedConstruction = (
  constructor: Function,
  props: Record<PropertyKey, unknown>
): (() => void) => {
  const stack = contexts.get(constructor) ?? []
  const context: ConstructionContext = { input: props, props }
  let active = true

  stack.push(context)
  contexts.set(constructor, stack)

  return () => {
    if (!active) return
    active = false

    const current = contexts.get(constructor)
    if (current === undefined) return

    const index = current.lastIndexOf(context)
    if (index >= 0) current.splice(index, 1)
    if (current.length === 0) contexts.delete(constructor)
  }
}

export const withPrevalidatedConstruction = <Value>(
  constructor: Function,
  props: Record<PropertyKey, unknown>,
  construct: () => Value
): Value => {
  const leave = enterPrevalidatedConstruction(constructor, props)

  try {
    return construct()
  } finally {
    leave()
  }
}

export const getPrevalidatedConstruction = (
  constructor: Function | undefined,
  input: unknown
): Record<PropertyKey, unknown> | undefined => {
  if (constructor === undefined) return undefined

  const stack = contexts.get(constructor)
  if (stack === undefined) return undefined

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const context = stack[index]
    if (context !== undefined && Object.is(context.input, input)) {
      return context.props
    }
  }

  return undefined
}
