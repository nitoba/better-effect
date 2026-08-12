import type { AnyServiceToken } from './types'

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
