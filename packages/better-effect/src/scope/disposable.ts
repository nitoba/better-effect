import type { ScopeFinalizer } from './types'

const SCOPE_SUCCESS = { status: 'success' } as const

type Disposer = (...args: never[]) => void | PromiseLike<void>

type DisposableCandidate = {
  [Symbol.dispose]?: Disposer

  [Symbol.asyncDispose]?: Disposer
}

/** Return a Scope finalizer for a value's async or sync disposal protocol. */
export const getDisposeFinalizer = <Resource>(resource: Resource): ScopeFinalizer | undefined => {
  // SAFETY: Object() provides a property-bearing view for protocol lookup; each method is checked for callability before invocation.
  const candidate = Object(resource) as DisposableCandidate
  const asyncDispose = candidate[Symbol.asyncDispose]

  if (asyncDispose instanceof Function) {
    return () => asyncDispose.call(resource)
  }

  const dispose = candidate[Symbol.dispose]

  if (dispose instanceof Function) {
    return () => dispose.call(resource)
  }

  return undefined
}

/** Dispose a value immediately when it implements a disposal protocol. */
export const disposeResource = <Resource>(resource: Resource): void | PromiseLike<void> => {
  const finalizer = getDisposeFinalizer(resource)

  return finalizer?.(SCOPE_SUCCESS)
}
