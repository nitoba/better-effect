import { ResourceNotDisposableError, ScopeCloseError, ScopeClosedError } from './errors'

import { getDisposeFinalizer } from './disposable'

import { runScoped } from './internal'

import { ScopeRuntime } from './runtime'

import type { DisposableResource, MaybePromise, ScopeFinalizer, ScopeOutcome } from './types'

export interface Scope {
  addFinalizer(finalizer: ScopeFinalizer): void

  acquire<R>(
    acquire: () => MaybePromise<R>,
    release: (resource: R, outcome: ScopeOutcome) => MaybePromise<void>
  ): Promise<R>

  add<R extends DisposableResource>(resource: R): Promise<R>

  fork(): CloseableScope
}

export interface CloseableScope extends Scope {
  close(outcome?: ScopeOutcome): Promise<void>
}

const SCOPE_SUCCESS: ScopeOutcome = Object.freeze({ status: 'success' })

class ScopeImpl implements CloseableScope {
  private readonly children = new Set<ScopeImpl>()

  private readonly finalizers: ScopeFinalizer[] = []

  private closePromise: Promise<void> | undefined

  private closeOutcome: ScopeOutcome | undefined

  constructor(private parent?: ScopeImpl) {}

  fork(): CloseableScope {
    this.assertOpen()

    const child = new ScopeImpl(this)

    this.children.add(child)

    return child
  }

  addFinalizer(finalizer: ScopeFinalizer): void {
    this.assertOpen()

    this.finalizers.push(finalizer)
  }

  async acquire<R>(
    acquire: () => MaybePromise<R>,
    release: (resource: R, outcome: ScopeOutcome) => MaybePromise<void>
  ): Promise<R> {
    this.assertOpen()

    const resource = await acquire()

    try {
      this.addFinalizer((outcome) => release(resource, outcome))

      return resource
    } catch (scopeFailure) {
      try {
        await release(resource, this.closeOutcome ?? SCOPE_SUCCESS)
      } catch (releaseFailure) {
        throw new AggregateError(
          [scopeFailure, releaseFailure],
          'Scope closed while acquiring a resource and immediate cleanup also failed'
        )
      }

      throw scopeFailure
    }
  }

  async add<R extends DisposableResource>(resource: R): Promise<R> {
    const finalizer = getDisposeFinalizer(resource)

    if (!finalizer) {
      throw new ResourceNotDisposableError()
    }

    try {
      this.addFinalizer(finalizer)

      return resource
    } catch (scopeFailure) {
      try {
        await finalizer(this.closeOutcome ?? SCOPE_SUCCESS)
      } catch (releaseFailure) {
        throw new AggregateError(
          [scopeFailure, releaseFailure],
          'Scope closed while adding a disposable resource and cleanup also failed'
        )
      }

      throw scopeFailure
    }
  }

  close(outcome: ScopeOutcome = SCOPE_SUCCESS): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }

    this.closeOutcome = outcome
    this.closePromise = ScopeRuntime.run(this, () => this.closeInternal(outcome))

    return this.closePromise
  }

  private async closeInternal(outcome: ScopeOutcome): Promise<void> {
    const failures: unknown[] = []

    const children = [...this.children]

    this.children.clear()

    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]

      if (!child) {
        continue
      }

      try {
        await child.close(outcome)
      } catch (cause) {
        if (cause instanceof ScopeCloseError) {
          failures.push(...cause.causes)
        } else {
          failures.push(cause)
        }
      }
    }

    for (let index = this.finalizers.length - 1; index >= 0; index--) {
      const finalizer = this.finalizers[index]

      if (!finalizer) {
        continue
      }

      try {
        await finalizer(outcome)
      } catch (cause) {
        failures.push(cause)
      }
    }

    this.finalizers.length = 0

    this.detach()

    if (failures.length > 0) {
      throw new ScopeCloseError(failures)
    }
  }

  private detach(): void {
    const parent = this.parent

    if (!parent) {
      return
    }

    parent.children.delete(this)
    this.parent = undefined
  }

  private assertOpen(): void {
    if (this.closePromise) {
      throw new ScopeClosedError()
    }
  }
}

export const Scope = {
  make(): CloseableScope {
    return new ScopeImpl()
  },

  current(): Scope {
    return ScopeRuntime.current()
  },

  provide<A>(scope: Scope, program: () => A): A {
    return ScopeRuntime.run(scope, program)
  },

  // oxlint-disable-next-line require-yield
  *[Symbol.iterator](): Generator<never, Scope, unknown> {
    return ScopeRuntime.current()
  },

  /**
   * Run a program in a newly owned Scope.
   *
   * Scope is independent from `better-result`, so returned values—including
   * `Result.err`—close this Scope with a successful outcome. Result-aware
   * outcome classification belongs to `Runtime.run`.
   */
  run<A>(program: (scope: Scope) => A | PromiseLike<A>): Promise<Awaited<A>> {
    const scope = new ScopeImpl()

    return runScoped(scope, () => program(scope), {
      classify: () => SCOPE_SUCCESS
    })
  }
} as const
