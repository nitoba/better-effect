export type MaybePromise<T> = T | PromiseLike<T>

export type ScopeFinalizer = () => MaybePromise<void>

export type DisposableResource = {
  [Symbol.dispose]?: () => void

  [Symbol.asyncDispose]?: () => MaybePromise<void>
}
