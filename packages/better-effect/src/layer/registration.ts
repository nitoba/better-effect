import { captureServiceTag, validateServiceTag } from '../service/tag'

import type { LayerRegistration } from './types'

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate unchecked registrations at the adapter boundary.
const validateRegistrationTag = (service: unknown, registrationTag: unknown): string => {
  const tokenTag = captureServiceTag(service)

  if (registrationTag === undefined) {
    return tokenTag
  }

  const canonicalTag = validateServiceTag(registrationTag)

  if (canonicalTag !== tokenTag) {
    throw new TypeError('Layer registration tag does not match its Service token')
  }

  return canonicalTag
}

/** Capture and validate the logical identity carried by a backend registration. */
export const captureLayerRegistrationTag = (registration: LayerRegistration): string => {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Reject forged registrations before reading their fields.
  if (typeof registration !== 'object' || registration === null) {
    throw new TypeError('Layer registrations must be objects')
  }

  return validateRegistrationTag(registration.service, registration.serviceTag)
}

/** Detach a registration from mutable caller-owned objects at the backend boundary. */
export const normalizeLayerRegistration = (registration: LayerRegistration): LayerRegistration => {
  const service = registration.service
  const registrationTag = registration.serviceTag
  const acquire = registration.acquire
  const serviceTag = validateRegistrationTag(service, registrationTag)

  return Object.freeze({
    service,
    serviceTag,
    acquire
  })
}
