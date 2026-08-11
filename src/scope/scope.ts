import { ResourceNotDisposableError, ScopeCloseError, ScopeClosedError } from './errors'

import { getDisposeFinalizer } from './disposable'

import { runScoped } from './internal'

import { ScopeRuntime } from './runtime'

import type { DisposableResource, MaybePromise, ScopeFinalizer } from './types'

export class Scope {
  private readonly children = new Set<Scope>()

  private readonly finalizers: ScopeFinalizer[] = []

  private closePromise: Promise<void> | undefined

  private constructor(private parent?: Scope) {}

  static make(): Scope {
    return new Scope()
  }

  static current(): Scope {
    return ScopeRuntime.current()
  }

  static provide<A>(scope: Scope, program: () => A): A {
    return ScopeRuntime.run(scope, program)
  }

  // oxlint-disable-next-line require-yield
  static *[Symbol.iterator](): Generator<never, Scope, unknown> {
    return ScopeRuntime.current()
  }

  static run<A>(program: (scope: Scope) => A | PromiseLike<A>): Promise<Awaited<A>> {
    const scope = Scope.make()

    return runScoped(scope, () => program(scope))
  }

  fork(): Scope {
    this.assertOpen()

    const child = new Scope(this)

    this.children.add(child)

    return child
  }

  addFinalizer(finalizer: ScopeFinalizer): void {
    this.assertOpen()

    this.finalizers.push(finalizer)
  }

  async acquire<R>(
    acquire: () => MaybePromise<R>,
    release: (resource: R) => MaybePromise<void>
  ): Promise<R> {
    this.assertOpen()

    const resource = await acquire()

    try {
      this.addFinalizer(() => release(resource))

      return resource
    } catch (scopeFailure) {
      try {
        await release(resource)
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
        await finalizer()
      } catch (releaseFailure) {
        throw new AggregateError(
          [scopeFailure, releaseFailure],
          'Scope closed while adding a disposable resource and cleanup also failed'
        )
      }

      throw scopeFailure
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }

    this.closePromise = Promise.resolve(ScopeRuntime.run(this, () => this.closeInternal()))

    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    const failures: unknown[] = []

    const children = [...this.children]

    this.children.clear()

    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]

      if (!child) {
        continue
      }

      try {
        await child.close()
      } catch (cause) {
        failures.push(cause)
      }
    }

    for (let index = this.finalizers.length - 1; index >= 0; index--) {
      const finalizer = this.finalizers[index]

      if (!finalizer) {
        continue
      }

      try {
        await finalizer()
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
