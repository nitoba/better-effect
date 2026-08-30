import { Codec, JobId, JobRegistry, Queue, protocolVersion } from 'better-effect-mq'
import * as core from 'better-effect-mq'
import * as testing from 'better-effect-mq/testing'
import packageJson from 'better-effect-mq/package.json' with { type: 'json' }
import type { JobRecord, JsonValue } from 'better-effect-mq'

const packageName: string = packageJson.name
const version: 1 = protocolVersion
const id = JobId.make('external-job')
const payload: JsonValue = { source: 'external' }
const recordState: JobRecord['state'] = 'waiting'
const codec = Codec.json<{ readonly source: string }>()
const encoded = codec.encode({ source: 'external' })
const queue = Queue.define('external')
const job = queue.job('smoke', { version: 1, payload: codec })
const registry = JobRegistry.make([job] as const)
const found = registry.lookup(job.identity)

void core
void testing
void packageName
void version
void id
void payload
void recordState
void encoded
void found
