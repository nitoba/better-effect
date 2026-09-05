import { captureServiceTag } from '../service/tag'
import type { AnyServiceToken } from '../service'
import type { ScopeOutcome } from '../scope'

type LayerCause = Extract<ScopeOutcome, { readonly status: 'failure' }>['cause']

/** Thrown when a Layer registers the same Service tag more than once. */
export class DuplicateServiceError extends Error {
  constructor(readonly service: AnyServiceToken) {
    super(`Duplicate service tag "${captureServiceTag(service)}"`)

    this.name = 'DuplicateServiceError'
  }
}

/** Thrown when one Service tag is associated with incompatible constructors. */
export class ServiceTagCollisionError extends Error {
  constructor(
    readonly existing: AnyServiceToken,
    readonly incoming: AnyServiceToken
  ) {
    super(
      `Service tag "${captureServiceTag(incoming)}" is already associated with "${existing.name}" ` +
        `and cannot be associated with "${incoming.name}"`
    )

    this.name = 'ServiceTagCollisionError'
  }
}

/** Thrown when a backend fails while registering a Layer provider. */
export class LayerRegistrationError extends Error {
  constructor(
    readonly service: AnyServiceToken | undefined,
    readonly registrationCause: LayerCause,
    readonly cleanupCause?: LayerCause
  ) {
    super(
      service
        ? `Failed to register service "${captureServiceTag(service)}"`
        : 'Failed to build Layer',
      {
        cause: registrationCause
      }
    )

    this.name = 'LayerRegistrationError'
  }
}

/** Thrown when one or more Layer-owned resources fail during disposal. */
export class LayerDisposeError extends Error {
  constructor(readonly causes: readonly unknown[]) {
    super(`Failed to dispose Layer (${causes.length} error${causes.length === 1 ? '' : 's'})`)

    this.name = 'LayerDisposeError'
  }
}

/** Thrown when a Layer generator yields a value other than a Service requirement. */
export class LayerGeneratorYieldError extends Error {
  constructor(readonly service: AnyServiceToken) {
    super(`Layer.gen("${captureServiceTag(service)}") yielded an unsupported value`)

    this.name = 'LayerGeneratorYieldError'
  }
}
