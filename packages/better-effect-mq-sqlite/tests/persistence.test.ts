// oxlint-disable anti-slop/no-runtime-typeof -- fixed SQLite test rows are narrowed after the query boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixed selected-column assertions are documented at the query site.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { Runtime } from 'better-effect'
import { makeQueueName, makeWorkerId } from 'better-effect-mq'
import { SqliteJobStore } from '../src/index'
import { layerFromFile as bunLayerFromFile } from '../src/bun'
import { layerFromFile as nodeLayerFromFile } from '../src/node'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SQLite durable coordination', () => {
  test('Node and Bun adapter-owned file layers do not leak path into generic config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-effect-mq-sqlite-'))
    directories.push(directory)
    for (const [name, layer] of [
      ['node.sqlite', nodeLayerFromFile],
      ['bun.sqlite', bunLayerFromFile]
    ] as const) {
      const path = join(directory, name)
      const database = new Database(path)
      SqliteJobStore.migrate({ database })
      database.close()
      const runtime = await Runtime.make(layer({ path }))
      await runtime.dispose()
    }
  })

  test('persists work and lets two connections claim one live lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-effect-mq-sqlite-'))
    directories.push(directory)
    const path = join(directory, 'jobs.sqlite')
    const firstDatabase = new Database(path)
    SqliteJobStore.migrate({ database: firstDatabase })
    const secondDatabase = new Database(path)
    try {
      const first = SqliteJobStore.make({ database: firstDatabase })
      const second = SqliteJobStore.make({ database: secondDatabase, pollIntervalMs: 5 })
      const queue = makeQueueName('desktop').unwrap()
      const empty = await second.claim({
        queue,
        accepted: [],
        limit: 1,
        workerId: makeWorkerId('poll').unwrap(),
        leaseDurationMs: 1_000,
        now: 0
      })
      if (empty.isErr()) throw empty.error
      const waking = second.awaitWake({
        queues: [queue],
        wakeToken: empty.value.wakeToken,
        signal: new AbortController().signal
      })
      const enqueued = await first.enqueue({
        job: { queue, name: 'persisted', version: 1 },
        payload: { durable: true },
        runAt: 0,
        attemptsMax: 2,
        now: 0
      })
      expect(enqueued.isOk()).toBe(true)
      expect((await waking).isOk()).toBe(true)
      // SAFETY: these test queries select fixed column aliases from the migrated schema.
      const persisted = secondDatabase
        .prepare('SELECT record_json FROM better_effect_mq_jobs WHERE namespace = ?')
        .get('default') as { readonly record_json?: unknown } | null
      const metadata = secondDatabase
        .prepare('SELECT state_json FROM better_effect_mq_sqlite_state WHERE namespace = ?')
        .get('default') as { readonly state_json?: unknown } | null
      expect(typeof persisted?.record_json).toBe('string')
      expect(JSON.parse(String(metadata?.state_json))).not.toHaveProperty('jobs')
      const [left, right] = await Promise.all([
        first.claim({
          queue,
          accepted: [{ queue, name: 'persisted', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('first').unwrap(),
          leaseDurationMs: 1_000,
          now: 1
        }),
        second.claim({
          queue,
          accepted: [{ queue, name: 'persisted', version: 1 }],
          limit: 1,
          workerId: makeWorkerId('second').unwrap(),
          leaseDurationMs: 1_000,
          now: 1
        })
      ])
      expect(left.isOk() && right.isOk() && left.value.jobs.length + right.value.jobs.length).toBe(
        1
      )
    } finally {
      firstDatabase.close()
      secondDatabase.close()
    }
  })
})
