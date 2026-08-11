import type { DisposableResource, ScopeFinalizer } from './types'

export const getDisposeFinalizer = (resource: DisposableResource): ScopeFinalizer | undefined => {
  const asyncDispose = resource[Symbol.asyncDispose]

  if (asyncDispose) {
    return () => asyncDispose.call(resource)
  }

  const dispose = resource[Symbol.dispose]

  if (dispose) {
    return () => dispose.call(resource)
  }

  return undefined
}

export const disposeResource = (resource: unknown): void | PromiseLike<void> => {
  const candidate = Object(resource) as DisposableResource
  const finalizer = getDisposeFinalizer(candidate)

  return finalizer?.()
}
