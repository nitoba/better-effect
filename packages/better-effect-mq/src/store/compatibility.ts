// oxlint-disable anti-slop/no-runtime-typeof -- descriptors cross the JavaScript adapter boundary.
// oxlint-disable anti-slop/no-unknown-parameters -- validation accepts untyped adapter metadata.
// oxlint-disable anti-slop/no-unsafe-dictionary-type -- this dictionary is only a narrowed host-object probe.
// oxlint-disable anti-slop/no-object-parameters -- reflection helpers operate on arbitrary host objects.
// oxlint-disable anti-slop/no-unknown-returns -- reflection returns values that are parsed immediately.

import { JobStoreProtocolMismatchError, protocolVersion } from '../protocol'

import type { JobStoreCapabilities, JobStoreDescriptor } from './types'

const maxDiagnosticLength = 128
const missing = Symbol('missing descriptor field')
const capabilityNames = [
  'queueFilteredNotifications',
  'nativeBatchEnqueue',
  'nativeBatchClaim',
  'metadataIndex',
  'transactionalEnqueue',
  'durableChangeFeed',
  'globalConcurrency',
  'rateLimiting'
] as const satisfies readonly (keyof JobStoreCapabilities)[]
const descriptorNames = [
  'protocolVersion',
  'adapter',
  'adapterVersion',
  'layoutVersion',
  'capabilities'
] as const

type CapabilityName = (typeof capabilityNames)[number]

const diagnosticText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= maxDiagnosticLength
    ? value
    : undefined

// Adapter metadata is copied into a public error. Keep control characters,
// delimiters, and escape sequences out of that diagnostic surface.
const diagnosticIdentifier = (value: unknown): string | undefined => {
  const text = diagnosticText(value)
  return text !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : undefined
}

const diagnosticVersion = (value: unknown): number | string | undefined =>
  (typeof value === 'number' && Number.isSafeInteger(value)) ||
  (typeof value === 'string' && value.length > 0 && value.length <= maxDiagnosticLength)
    ? value
    : undefined

const isPlainObject = (value: unknown): value is object => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const ownDataValue = (value: object, name: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : missing
}

const hasExactOwnedDataFields = (value: object, names: readonly string[]): boolean => {
  const keys = Reflect.ownKeys(value)
  if (keys.length !== names.length) return false
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor !== undefined && 'value' in descriptor
  })
}

const isCapabilities = (value: unknown): value is JobStoreCapabilities => {
  try {
    if (!isPlainObject(value) || !Object.isFrozen(value)) return false
    if (!hasExactOwnedDataFields(value, capabilityNames)) return false

    const metadataIndex = ownDataValue(value, 'metadataIndex')
    if (metadataIndex !== 'none' && metadataIndex !== 'residual' && metadataIndex !== 'indexed') {
      return false
    }

    return capabilityNames.every((name: CapabilityName) => {
      const capability = ownDataValue(value, name)
      return name === 'metadataIndex' || typeof capability === 'boolean'
    })
  } catch {
    return false
  }
}

/** Return whether an unknown adapter value is a complete immutable protocol-v1 descriptor. */
export const isJobStoreDescriptor = (value: unknown): value is JobStoreDescriptor => {
  try {
    if (!isPlainObject(value) || !Object.isFrozen(value)) return false
    if (!hasExactOwnedDataFields(value, descriptorNames)) return false
    if (ownDataValue(value, 'protocolVersion') !== protocolVersion) return false

    const adapter = ownDataValue(value, 'adapter')
    const adapterVersion = ownDataValue(value, 'adapterVersion')
    const layoutVersion = ownDataValue(value, 'layoutVersion')
    return (
      diagnosticText(adapter) !== undefined &&
      diagnosticText(adapterVersion) !== undefined &&
      diagnosticVersion(layoutVersion) !== undefined &&
      isCapabilities(ownDataValue(value, 'capabilities'))
    )
  } catch {
    return false
  }
}

/**
 * Validate the startup handshake without inspecting adapter-specific clients.
 *
 * The return value is the original descriptor, preserving the adapter's
 * immutable object identity for callers that use it for diagnostics.
 */
export const assertJobStoreProtocolCompatible = (value: unknown): JobStoreDescriptor => {
  let actual: number | string | undefined
  let adapter: string | undefined
  let adapterVersion: string | undefined
  try {
    if (isPlainObject(value)) {
      const protocol = ownDataValue(value, 'protocolVersion')
      const adapterValue = ownDataValue(value, 'adapter')
      const adapterVersionValue = ownDataValue(value, 'adapterVersion')
      actual = protocol === missing ? undefined : diagnosticVersion(protocol)
      adapter = adapterValue === missing ? undefined : diagnosticIdentifier(adapterValue)
      adapterVersion =
        adapterVersionValue === missing ? undefined : diagnosticIdentifier(adapterVersionValue)
    }
  } catch {
    // The mismatch error is the public boundary for hostile descriptor objects.
  }

  if (!isJobStoreDescriptor(value)) {
    throw new JobStoreProtocolMismatchError({
      expected: protocolVersion,
      actual,
      adapter,
      adapterVersion,
      message:
        actual === protocolVersion
          ? 'JobStore protocol-v1 descriptor is missing required immutable metadata'
          : undefined
    })
  }

  return value
}
