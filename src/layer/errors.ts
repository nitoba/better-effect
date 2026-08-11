import type { ServiceClass } from '../service'

export class DuplicateServiceError extends Error {
  constructor(readonly service: ServiceClass<any>) {
    super(`Duplicate service "${service.name}"`)

    this.name = 'DuplicateServiceError'
  }
}

export class LayerRegistrationError extends Error {
  constructor(
    readonly service: ServiceClass<any> | undefined,
    readonly registrationCause: unknown,
    readonly cleanupCause?: unknown
  ) {
    super(service ? `Failed to register service "${service.name}"` : 'Failed to build Layer', {
      cause: registrationCause
    })

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
    super(`Layer.gen("${service.name}") yielded an unsupported value`)

    this.name = 'LayerGeneratorYieldError'
  }
}
