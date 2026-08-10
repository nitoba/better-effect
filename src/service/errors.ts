import type { AnyServiceToken } from './types'

export class ServiceRuntimeNotConfiguredError extends Error {
  constructor() {
    super('No ServiceResolver is available in the current runtime context')

    this.name = 'ServiceRuntimeNotConfiguredError'
  }
}

export class ServiceNotFoundError extends Error {
  constructor(readonly service: AnyServiceToken) {
    super(`Service "${service.name}" was not provided`)

    this.name = 'ServiceNotFoundError'
  }
}
