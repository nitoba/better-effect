import type { AnyServiceToken, ServiceClass } from '../service'

export class DuplicateServiceError extends Error {
  constructor(readonly service: ServiceClass<any>) {
    super(`Duplicate service tag "${service.serviceTag}"`)

    this.name = 'DuplicateServiceError'
  }
}

export class ServiceTagCollisionError extends Error {
  constructor(
    readonly existing: AnyServiceToken,
    readonly incoming: AnyServiceToken
  ) {
    super(
      `Service tag "${incoming.serviceTag}" is already associated with "${existing.name}" ` +
        `and cannot be associated with "${incoming.name}"`
    )

    this.name = 'ServiceTagCollisionError'
  }
}

export class LayerRegistrationError extends Error {
  constructor(
    readonly service: ServiceClass<any> | undefined,
    readonly registrationCause: unknown,
    readonly cleanupCause?: unknown
  ) {
    super(
      service ? `Failed to register service "${service.serviceTag}"` : 'Failed to build Layer',
      {
        cause: registrationCause
      }
    )

    this.name = 'LayerRegistrationError'
  }
}

export class LayerDisposeError extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super(`Failed to dispose Layer (${causes.length} error${causes.length === 1 ? '' : 's'})`)

    this.name = 'LayerDisposeError'
  }
}

export class LayerGeneratorYieldError extends Error {
  constructor(readonly service: ServiceClass<any>) {
    super(`Layer.gen("${service.serviceTag}") yielded an unsupported value`)

    this.name = 'LayerGeneratorYieldError'
  }
}
