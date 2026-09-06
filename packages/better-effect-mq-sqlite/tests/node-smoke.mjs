import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Runtime, ServiceRuntime, Layer } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { SqliteJobScheduleStore, SqliteJobStore } from '../dist/index.mjs'
import { openSqlite, layerFromFile } from '../dist/node.mjs'

const path = join(tmpdir(), `better-effect-mq-sqlite-node-${crypto.randomUUID()}.sqlite`)

try {
  const database = openSqlite(path)
  SqliteJobStore.migrate({ database })
  database.close?.()

  const runtime = await Runtime.make(layerFromFile({ path }))
  await runtime.dispose()

  const shared = openSqlite(path)
  const sharedRuntime = await Runtime.make(
    Layer.merge(
      SqliteJobStore.layer({ database: shared }),
      SqliteJobScheduleStore.layer({ database: shared })
    )
  )
  const schedules = await sharedRuntime.run(() => ServiceRuntime.resolve(JobScheduleStore))
  const jobs = await sharedRuntime.run(() => ServiceRuntime.resolve(JobStore))
  if (schedules.descriptor.extension !== 'better-effect-mq/schedules') {
    throw new Error('The Node schedule surface did not resolve the canonical descriptor')
  }
  if (jobs.descriptor.adapter !== 'sqlite') throw new Error('The Node JobStore did not resolve')
  await sharedRuntime.dispose()
  shared.close?.()

  assert.ok(true, 'the Node file layer opened and disposed its database')
} finally {
  await Promise.all([path, `${path}-shm`, `${path}-wal`].map((file) => rm(file, { force: true })))
}
