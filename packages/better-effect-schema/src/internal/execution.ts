import { SchemaAsyncRequired, SchemaExecutionFailure } from '../failure.js'
import { schemaFailure, schemaSuccess } from './result.js'
import type { SchemaEffect } from '../schema-effect.js'

export type SyncExecution<A> = SchemaEffect<A, SchemaExecutionFailure | SchemaAsyncRequired>

export type AsyncExecution<A> = SchemaEffect<A, SchemaExecutionFailure>

const asyncSignal = (cause: unknown): boolean => {
  try {
    if ((typeof cause !== 'object' || cause === null) && typeof cause !== 'function') {
      return false
    }

    const constructor = Reflect.get(cause, 'constructor')
    return (
      (typeof constructor === 'function' &&
        Reflect.get(constructor, 'name') === '$ZodAsyncError') ||
      Reflect.get(cause, 'name') === '$ZodAsyncError'
    )
  } catch {
    return false
  }
}

const inspectThenable = (
  value: unknown
): { readonly thenable: boolean; readonly failed: boolean; readonly cause?: unknown } => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { thenable: false, failed: false }
  }

  try {
    return { thenable: typeof Reflect.get(value, 'then') === 'function', failed: false }
  } catch (cause) {
    return { thenable: false, failed: true, cause }
  }
}

/** Invoke one synchronous provider and turn every unexpected throw into a Result failure. */
export const invokeSync = <A>(operation: string, thunk: () => A): SyncExecution<A> => {
  let value: A

  try {
    value = thunk()
  } catch (cause) {
    if (asyncSignal(cause)) {
      return schemaFailure<A, SchemaExecutionFailure | SchemaAsyncRequired>(
        new SchemaAsyncRequired({ operation, cause })
      )
    }

    return schemaFailure<A, SchemaExecutionFailure | SchemaAsyncRequired>(
      new SchemaExecutionFailure({ operation, cause })
    )
  }

  const inspected = inspectThenable(value)
  if (inspected.failed) {
    return schemaFailure<A, SchemaExecutionFailure | SchemaAsyncRequired>(
      new SchemaExecutionFailure({ operation, cause: inspected.cause })
    )
  }

  if (inspected.thenable) {
    // A rejected thenable must be observed even though the synchronous API cannot await it.
    try {
      void Promise.resolve(value).catch(() => undefined)
    } catch {
      // The value is already classified as an async result. The observer is best effort.
    }

    return schemaFailure<A, SchemaExecutionFailure | SchemaAsyncRequired>(
      new SchemaAsyncRequired({ operation, cause: value })
    )
  }

  return schemaSuccess<A, SchemaExecutionFailure | SchemaAsyncRequired>(value)
}

/** Await one asynchronous provider and normalize both throws and rejections. */
export const invokeAsync = async <A>(
  operation: string,
  thunk: () => A | PromiseLike<A>
): Promise<SchemaEffect<Awaited<A>, SchemaExecutionFailure>> => {
  try {
    return schemaSuccess<Awaited<A>, SchemaExecutionFailure>(await thunk())
  } catch (cause) {
    return schemaFailure<Awaited<A>, SchemaExecutionFailure>(
      new SchemaExecutionFailure({ operation, cause })
    )
  }
}
