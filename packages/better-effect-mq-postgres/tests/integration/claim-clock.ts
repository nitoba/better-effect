import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobStore, makeQueueName, makeWorkerId } from 'better-effect-mq'
import { Result } from 'better-result'
import { Pool } from 'pg'
import { PostgresJobStore, PostgresMigrator } from '../../src/index'

function valueOf<Value, Failure>(result: Result<Value, Failure>): Value {
  if (Result.isError(result)) throw result.error
  return result.value
}

const connectionString = process.env.MQ_TEST_DATABASE_URL
assert.ok(connectionString, 'MQ_TEST_DATABASE_URL must point to a dedicated test database')
const schema = `mq_claim_clock_${randomUUID().replaceAll('-', '')}`
const pool = new Pool({ connectionString, max: 4 })
try {
  await PostgresMigrator.run(pool, { schema })
  await using runtime = await Runtime.make(PostgresJobStore.layer({ pool, schema }))
  const jobs = await runtime.run(() => ServiceRuntime.resolve(JobStore))
  const queue = valueOf(makeQueueName('claim-clock'))
  const identity = { queue, name: 'ready', version: 1 }
  const earlier = valueOf(
    await jobs.enqueue({
      job: identity,
      payload: { key: 'earlier' },
      now: 100,
      runAt: 100,
      attemptsMax: 1
    })
  )
  // Both jobs are ready at insertion. The second transaction represents a write
  // committed after a competing Worker's claim sampled its explicit clock.
  const later = valueOf(
    await jobs.enqueue({
      job: identity,
      payload: { key: 'later' },
      now: 200,
      runAt: 100,
      attemptsMax: 1
    })
  )
  const request = {
    queue,
    accepted: [identity],
    workerId: valueOf(makeWorkerId('claim-clock')),
    limit: 2,
    leaseDurationMs: 2_000,
    now: 150
  }
  const first = await jobs.claim(request)
  assert.ok(Result.isOk(first), 'A newer ready job must not invalidate the older eligible claim')
  assert.deepEqual(
    first.value.jobs.map((job) => job.id),
    [earlier.job.id]
  )
  const deferred = valueOf(await jobs.getJob({ jobId: later.job.id }))
  assert.equal(deferred?.state, 'waiting')
  assert.equal(deferred.updatedAt, 200)
  assert.equal(deferred.leaseToken, undefined)
  assert.equal(deferred.deliveryCount, 0)
  const second = valueOf(await jobs.claim({ ...request, now: 200 }))
  assert.deepEqual(
    second.jobs.map((job) => job.id),
    [later.job.id]
  )
  assert.equal(second.jobs[0]?.leaseExpiresAt, 2_200)
  console.log(
    'PASS: stale claim samples defer newer records without dropping older work or backdating leases'
  )
} finally {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await pool.end()
  }
}
