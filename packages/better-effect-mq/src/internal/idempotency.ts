import { Result, type Result as ResultType } from 'better-result'

import { JobDefinitionError, makeJobId } from '../protocol'
import type { JobId } from '../protocol'
import type { JobIdentity } from '../job'

const algorithm = 'SHA-256'
const prefix = 'better-effect-mq/idempotency/v1'

type SubtleCrypto = {
  digest(algorithm: string, data: Uint8Array): PromiseLike<ArrayBuffer>
}

type RuntimeCrypto = {
  readonly crypto?: {
    readonly subtle?: SubtleCrypto
  }
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Derive the protocol-v1 producer ID for an idempotency key.
 *
 * The input is an unambiguous, NUL-delimited UTF-8 tuple. Queue, name, and
 * keys reject NUL characters at their public boundaries, so this representation
 * cannot have multiple parses. The algorithm and prefix are part of protocol v1.
 */
export const deriveIdempotencyJobId = async (
  identity: JobIdentity,
  key: string
): Promise<ResultType<JobId, JobDefinitionError>> => {
  // SAFETY: only the optional Web Crypto shape is read from the host runtime.
  const runtime = globalThis as typeof globalThis & RuntimeCrypto
  const subtle = runtime.crypto?.subtle
  if (subtle === undefined) {
    return Result.err(
      new JobDefinitionError({
        field: 'idempotencyKey',
        message: 'the runtime cannot derive a deterministic job ID'
      })
    )
  }

  try {
    const input = new TextEncoder().encode(
      [prefix, identity.queue, identity.name, String(identity.version), key].join('\u0000')
    )
    const digest = await subtle.digest(algorithm, input)
    const checked = makeJobId(`idem-v1-${hex(new Uint8Array(digest))}`)
    return checked
  } catch {
    return Result.err(
      new JobDefinitionError({
        field: 'idempotencyKey',
        message: 'the runtime could not derive a deterministic job ID'
      })
    )
  }
}
