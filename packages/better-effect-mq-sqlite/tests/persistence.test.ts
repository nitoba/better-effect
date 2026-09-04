import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { makeQueueName, makeWorkerId } from 'better-effect-mq'
import { SqliteJobStore } from '../src/index'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('SQLite durable coordination', () => {
  test('persists work and lets two connections claim one live lease', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'better-effect-mq-sqlite-'))
    directories.push(directory)
    const path = join(directory, 'jobs.sqlite')
    const firstDatabase = new Database(path)
    SqliteJobStore.migrate({ database: firstDatabase })
    const secondDatabase = new Database(path)
    try {
      const first = SqliteJobStore.make({ database: firstDatabase })
      const second = SqliteJobStore.make({ database: secondDatabase })
      const queue = makeQueueName('desktop').unwrap()
      const enqueued = await first.enqueue({
        job: { queue, name: 'persisted', version: 1 },
        payload: { durable: true },
        runAt: 0,
        attemptsMax: 2,
        now: 0
      })
      expect(enqueued.isOk()).toBe(true)
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
