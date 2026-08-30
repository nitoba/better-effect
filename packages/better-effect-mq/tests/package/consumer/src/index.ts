import { Codec, JobId, protocolVersion } from 'better-effect-mq'
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

void core
void testing
void packageName
void version
void id
void payload
void recordState
void encoded
