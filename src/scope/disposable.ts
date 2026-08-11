import type { ScopeFinalizer } from './types'

const SCOPE_SUCCESS = { status: 'success' } as const

type DisposableCandidate = {
  [Symbol.dispose]?: unknown

  [Symbol.asyncDispose]?: unknown
}

export const getDisposeFinalizer = (resource: unknown): ScopeFinalizer | undefined => {
  const candidate = Object(resource) as DisposableCandidate
  const asyncDispose = candidate[Symbol.asyncDispose]

  if (typeof asyncDispose === 'function') {
    return () => asyncDispose.call(resource)
  }

  const dispose = candidate[Symbol.dispose]

  if (typeof dispose === 'function') {
    return () => dispose.call(resource)
  }

  return undefined
}

export const disposeResource = (resource: unknown): void | PromiseLike<void> => {
  const finalizer = getDisposeFinalizer(resource)

  return finalizer?.(SCOPE_SUCCESS)
}
