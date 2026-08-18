import type { AnyServiceToken } from './types'

const formatResolutionPath = (path: readonly AnyServiceToken[]): string =>
  path.map((service) => service.serviceTag).join(' → ')

/** Thrown when a Service is accessed without an active runtime resolver. */
export class ServiceRuntimeNotConfiguredError extends Error {
  constructor() {
    super('No ServiceResolver is available in the current runtime context')

    this.name = 'ServiceRuntimeNotConfiguredError'
  }
}

/** Thrown when a runtime has no provider for the requested Service tag. */
export class ServiceNotFoundError extends Error {
  constructor(readonly service: AnyServiceToken) {
    super(`Service "${service.serviceTag}" was not provided`)

    this.name = 'ServiceNotFoundError'
  }
}

/** Thrown when resolving a Service re-enters a Service already in its path. */
export class CircularDependencyError extends Error {
  readonly path: readonly AnyServiceToken[]

  constructor(path: readonly AnyServiceToken[]) {
    const normalizedPath = Object.freeze([...path])

    super(`Circular Service dependency detected:\n${formatResolutionPath(normalizedPath)}`)

    this.name = 'CircularDependencyError'
    this.path = normalizedPath
  }
}

/** Thrown when a registered Service provider fails during lazy acquisition. */
export class ServiceAcquisitionError extends Error {
  override readonly cause: unknown

  constructor(
    readonly service: AnyServiceToken,
    resolutionPath: readonly AnyServiceToken[],
    cause: unknown
  ) {
    const normalizedPath = Object.freeze([...resolutionPath])

    super(
      `Failed to acquire Service "${service.serviceTag}"` +
        (normalizedPath.length > 0
          ? ` while resolving: ${formatResolutionPath(normalizedPath)}`
          : '')
    )

    this.name = 'ServiceAcquisitionError'
    this.cause = cause
    this.resolutionPath = normalizedPath
  }

  readonly resolutionPath: readonly AnyServiceToken[]
}
