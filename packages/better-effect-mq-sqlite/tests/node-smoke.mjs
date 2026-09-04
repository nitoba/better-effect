import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Runtime } from 'better-effect'
import { SqliteJobStore } from '../dist/index.mjs'
import { layerFromFile } from '../dist/node.mjs'

const path = join(tmpdir(), `better-effect-mq-sqlite-node-${crypto.randomUUID()}.sqlite`)

try {
  const database = new DatabaseSync(path)
  SqliteJobStore.migrate({ database })
  database.close()

  const runtime = await Runtime.make(layerFromFile({ path }))
  await runtime.dispose()

  assert.ok(true, 'the Node file layer opened and disposed its database')
} finally {
  await Promise.all([path, `${path}-shm`, `${path}-wal`].map((file) => rm(file, { force: true })))
}
