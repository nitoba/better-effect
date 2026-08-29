import { Layer } from '../layer'
import { Service } from '../service'

type HostCrypto = {
  readonly randomUUID?: () => string
}

const hostCrypto = (): HostCrypto | undefined => {
  // SAFETY: Supported hosts expose crypto on globalThis, but the optional property models older or restricted hosts.
  return (globalThis as { readonly crypto?: HostCrypto }).crypto
}

/** Thrown when the host does not expose the supported Web Crypto UUID API. */
export class IdGeneratorUnavailableError extends Error {
  constructor() {
    super('IdGenerator requires a host crypto.randomUUID implementation')

    this.name = 'IdGeneratorUnavailableError'
  }
}

/** Thrown when an {@link IdGeneratorTest} queue has no IDs left. */
export class IdGeneratorExhaustedError extends Error {
  constructor(readonly generated: number) {
    super(
      `IdGeneratorTest queue exhausted after ${generated} generated ID${generated === 1 ? '' : 's'}`
    )

    this.name = 'IdGeneratorExhaustedError'
  }
}

/** Host-backed UUID string ID service. */
export class IdGenerator extends Service<IdGenerator>()('IdGenerator') {
  /** Generate a cryptographically strong UUID string using the host Web Crypto API. */
  next(): string {
    const crypto = hostCrypto()

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- host feature detection must verify the callable Web Crypto method.
    if (crypto === undefined || typeof crypto.randomUUID !== 'function') {
      throw new IdGeneratorUnavailableError()
    }

    return crypto.randomUUID()
  }
}

/** The default host IdGenerator provider. */
export const IdGeneratorLive = Layer.make(IdGenerator)

type IdFactory = (index: number) => string

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- runtime validation protects the public string-ID boundary.
const validateId = (value: unknown, source: string): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime validation rejects unsafe test doubles.
  if (typeof value !== 'string') {
    throw new TypeError(`${source} must return a string ID`)
  }

  return value
}

/** Deterministic queue- or factory-backed IdGenerator implementation for tests. */
export class IdGeneratorTest implements Service.Contract<IdGenerator> {
  private readonly queue: string[]

  private factory: IdFactory | undefined

  private generatedCount = 0

  constructor(ids: readonly string[] = []) {
    this.queue = ids.map((id) => validateId(id, 'IdGeneratorTest queue values'))
  }

  /** Number of IDs successfully returned by this test generator. */
  get generated(): number {
    return this.generatedCount
  }

  /** Number of queued IDs still available, or Infinity for a factory. */
  get remaining(): number {
    return this.factory === undefined ? this.queue.length : Infinity
  }

  /** Return the next queued or factory-generated string ID. */
  next(): string {
    if (this.factory === undefined) {
      const value = this.queue.shift()

      if (value === undefined) {
        throw new IdGeneratorExhaustedError(this.generatedCount)
      }

      this.generatedCount += 1
      return value
    }

    const value = validateId(this.factory(this.generatedCount), 'IdGeneratorTest factory')
    this.generatedCount += 1
    return value
  }

  /**
   * Create a factory-backed generator. The factory receives a monotonic
   * zero-based index: the first call receives 0, then 1, and so on.
   */
  static from(factory: IdFactory): IdGeneratorTest {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- runtime validation rejects an invalid factory at the API boundary.
    if (typeof factory !== 'function') {
      throw new TypeError('IdGeneratorTest.from requires a factory function')
    }

    const generator = new IdGeneratorTest()
    generator.factory = factory
    return generator
  }

  /** Create a Layer for this generator, allocating a fresh empty queue by default. */
  static layer(generator: IdGeneratorTest = new IdGeneratorTest()) {
    return Layer.succeed(IdGenerator, generator)
  }
}

/** Compatible functional shorthand for {@link IdGeneratorTest.layer}. */
export const IdGeneratorTestLayer = (generator?: IdGeneratorTest) =>
  IdGeneratorTest.layer(generator)
