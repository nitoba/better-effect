import { describe, expect, test } from 'bun:test'

import {
  CircularDependencyError,
  DuplicateServiceError,
  Layer,
  Runtime,
  Service,
  ServiceNotFoundError,
  ServiceRuntime,
  ServiceTagCollisionError
} from '../src'

const captureRejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

class SqlUserRepository extends Service<SqlUserRepository>()('SqlUserRepository') {
  findById(id: string): string {
    return `sql:${id}`
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  declare findById: SqlUserRepository['findById']
}

class AlternateUserRepository extends Service<AlternateUserRepository>()('UserRepository') {
  findById(id: string): string {
    return `alternate:${id}`
  }
}

class CircularAliasA extends Service<CircularAliasA>()('CircularAliasA') {
  read(): string {
    return 'a'
  }
}

class CircularAliasB extends Service<CircularAliasB>()('CircularAliasB') {
  read(): string {
    return 'b'
  }
}

describe('Layer.empty', () => {
  test('is a stable immutable singleton and neutral to composition', () => {
    const empty = Layer.empty
    const serviceLayer = Layer.make(SqlUserRepository)
    // SAFETY: This test intentionally widens the class to exercise JavaScript assignment against the locked descriptor.
    const mutableLayer = Layer as { empty: Layer.Any }
    const descriptor = Object.getOwnPropertyDescriptor(Layer, 'empty')
    const merged = Layer.merge(empty, serviceLayer)

    expect(descriptor?.value).toBe(empty)
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.configurable).toBe(false)

    expect(() => {
      mutableLayer.empty = serviceLayer
    }).toThrow(TypeError)
    expect(() => {
      Object.defineProperty(Layer, 'empty', { value: serviceLayer })
    }).toThrow(TypeError)

    expect(Layer.empty).toBe(empty)
    expect(Object.isFrozen(empty)).toBe(true)
    expect(empty.providers).toEqual([])
    expect(Object.isFrozen(empty.providers)).toBe(true)

    const providersDescriptor = Object.getOwnPropertyDescriptor(empty, 'providers')
    expect(providersDescriptor?.writable).toBe(false)
    expect(providersDescriptor?.configurable).toBe(false)

    expect(merged.providers).toEqual(serviceLayer.providers)
    expect(merged.providers).not.toBe(empty.providers)
  })

  test('provides a complete environment for requirement-free programs', async () => {
    const runtime = await Runtime.make(Layer.empty)

    try {
      const value = await runtime.run(() => 42)
      expect(value).toBe(42)
    } finally {
      await runtime.dispose()
    }
  })
})

describe('Layer.alias', () => {
  test('resolves lazily and returns the exact source instance', async () => {
    const source = new SqlUserRepository()
    let acquisitions = 0
    const sourceLayer = Layer.make(SqlUserRepository, () => {
      acquisitions++
      return source
    })
    const alias = Layer.alias({ from: SqlUserRepository, to: UserRepository })
    const application = Layer.merge(Layer.empty, sourceLayer, alias)

    expect(acquisitions).toBe(0)

    const runtime = await Runtime.make(application)

    try {
      expect(acquisitions).toBe(0)

      const target = await runtime.run(() => ServiceRuntime.resolve(UserRepository))
      const resolvedSource = await runtime.run(() => ServiceRuntime.resolve(SqlUserRepository))

      expect(Object.is(target, source)).toBe(true)
      expect(Object.is(target, resolvedSource)).toBe(true)
      expect(target).toBeInstanceOf(SqlUserRepository)
      expect(target).not.toBeInstanceOf(UserRepository)
      expect(Object.getPrototypeOf(target)).toBe(SqlUserRepository.prototype)
      expect(target.findById('42')).toBe('sql:42')
      expect(acquisitions).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves missing-source diagnostics', async () => {
    const alias = Layer.alias({ from: SqlUserRepository, to: UserRepository })
    // SAFETY: This test intentionally erases the incomplete alias to exercise its runtime diagnostic.
    const runtime = await Runtime.make(alias as Layer.Any)

    try {
      const error = await captureRejection(
        runtime.run(() => ServiceRuntime.resolve(UserRepository))
      )

      expect(error).toBeInstanceOf(ServiceNotFoundError)

      if (error instanceof ServiceNotFoundError) {
        expect(error.service).toBe(SqlUserRepository)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('retains duplicate and tag-collision behavior', () => {
    const alias = Layer.alias({ from: SqlUserRepository, to: UserRepository })

    expect(() => Layer.merge(alias, Layer.make(UserRepository))).toThrow(DuplicateServiceError)
    expect(() => Layer.merge(alias, Layer.make(AlternateUserRepository))).toThrow(
      ServiceTagCollisionError
    )
  })

  test('uses existing circular-resolution diagnostics', async () => {
    const aFromB = Layer.alias({ from: CircularAliasB, to: CircularAliasA })
    const bFromA = Layer.alias({ from: CircularAliasA, to: CircularAliasB })
    const runtime = await Runtime.make(Layer.merge(aFromB, bFromA))

    try {
      const error = await captureRejection(
        runtime.run(() => ServiceRuntime.resolve(CircularAliasA))
      )

      expect(error).toBeInstanceOf(CircularDependencyError)

      if (error instanceof CircularDependencyError) {
        expect(error.path.map((service) => service.serviceTag)).toEqual([
          'CircularAliasA',
          'CircularAliasB',
          'CircularAliasA'
        ])
      }
    } finally {
      await runtime.dispose()
    }
  })
})
