// oxlint-disable anti-slop/no-chained-type-assertions -- tests narrow the generic driver and structural extension boundaries.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the casts are confined to controlled test setup.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- test requests intentionally omit optional fields.
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  Queue,
  QueueControls,
  makeJobId,
  makeQueueName,
  makeWorkerId,
  type ControlledJobStoreContract,
  type JobStoreError,
  type JobStoreOperation
} from 'better-effect-mq'
import { Result } from 'better-result'
import { SqliteJobStore, type SqliteDatabase, type SqliteJobStoreConfig } from '../src/index'

const databases: Database[] = []

const resolve = async <Value>(
  operation: JobStoreOperation<Value, JobStoreError>
): Promise<Value> => {
  const result = await operation
  if (Result.isError(result)) throw result.error
  return result.value
}

const makeStore = (): SqliteJobStoreConfig => {
  const database = new Database(':memory:')
  databases.push(database)
  SqliteJobStore.migrate({ database })
  return { database: database as unknown as SqliteDatabase, namespace: 'controlled' }
}

const identity = (queue: string) => ({ queue, name: 'work', version: 1 }) as const

const enqueue = (
  store: ReturnType<typeof SqliteJobStore.make>,
  id: string,
  queue: string,
  key?: string
) =>
  store.enqueue({
    id: makeJobId(id).unwrap(),
    job: identity(queue),
    payload: key === undefined ? {} : { key },
    ...(key === undefined ? {} : { dispatchKey: key }),
    runAt: 0,
    attemptsMax: 2,
    now: 0
  })

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('SQLite QueueControls protocol v3', () => {
  test('claimControlled enforces global, per-key, and anchored rate limits atomically', async () => {
    const store = SqliteJobStore.make(makeStore())
    const controlled = store as unknown as ControlledJobStoreContract
    expect(store.descriptor.capabilities.globalConcurrency).toBe(true)
    expect(store.descriptor.capabilities.rateLimiting).toBe(true)
    const queue = Queue.define('controlled-basic')
    const registry = QueueControls.registry({
      group: 'controlled-tests',
      controls: [
        QueueControls.define(queue, {
          globalConcurrency: 2,
          concurrencyKey: { derive: (payload: { readonly key: string }) => payload.key, max: 1 },
          rateLimit: { max: 2, durationMs: 100 }
        })
      ]
    })
    const record = await resolve(controlled.reconcile(registry))

    for (const [id, key] of [
      ['a-1', 'a'],
      ['a-2', 'a'],
      ['b-1', 'b'],
      ['c-1', 'c']
    ] as const) {
      await resolve(
        store.enqueue({
          id: makeJobId(id).unwrap(),
          job: identity('controlled-basic'),
          payload: { key },
          dispatchKey: key,
          runAt: 0,
          attemptsMax: 2,
          now: 0
        })
      )
    }

    const claim = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('controlled-basic').unwrap(),
        accepted: [identity('controlled-basic')],
        limit: 3,
        workerId: makeWorkerId('worker-a').unwrap(),
        leaseDurationMs: 50,
        now: 0,
        controlsRevision: record.records[0]!.revision
      })
    )
    expect(claim.jobs.map((job) => job.id)).toEqual([
      makeJobId('a-1').unwrap(),
      makeJobId('b-1').unwrap()
    ])

    const blocked = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('controlled-basic').unwrap(),
        accepted: [identity('controlled-basic')],
        limit: 1,
        workerId: makeWorkerId('worker-b').unwrap(),
        leaseDurationMs: 50,
        now: 0,
        controlsRevision: 1
      })
    )
    expect(blocked.reason).toBe('global-concurrency')

    await Promise.all(
      claim.jobs.map((job) =>
        resolve(
          controlled.settleControlled({
            jobId: job.id,
            leaseToken: job.leaseToken,
            outcome: { type: 'complete' },
            now: 1,
            controlsRevision: 1
          })
        )
      )
    )
    const rateLimited = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('controlled-basic').unwrap(),
        accepted: [identity('controlled-basic')],
        limit: 1,
        workerId: makeWorkerId('worker-c').unwrap(),
        leaseDurationMs: 50,
        now: 1,
        controlsRevision: 1
      })
    )
    expect(rateLimited.reason).toBe('rate-limited')
    expect(rateLimited.nextEligibleAtMs).toBe(100)
    const nextWindow = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('controlled-basic').unwrap(),
        accepted: [identity('controlled-basic')],
        limit: 1,
        workerId: makeWorkerId('worker-d').unwrap(),
        leaseDurationMs: 50,
        now: 100,
        controlsRevision: 1
      })
    )
    expect(nextWindow.jobs).toHaveLength(1)
    expect(nextWindow.jobs[0]?.id).toBe(makeJobId('c-1').unwrap())
  })

  test('serializes claims across connections and persists controls, permits, and rate windows', async () => {
    const database = new Database(':memory:')
    databases.push(database)
    SqliteJobStore.migrate({ database })
    const first = SqliteJobStore.make({
      database: database as unknown as SqliteDatabase,
      namespace: 'shared'
    })
    const second = SqliteJobStore.make({
      database: database as unknown as SqliteDatabase,
      namespace: 'shared'
    })
    const firstControlled = first as unknown as ControlledJobStoreContract
    const secondControlled = second as unknown as ControlledJobStoreContract
    const queue = Queue.define('shared-controls')
    const registry = QueueControls.registry({
      group: 'shared-tests',
      controls: [
        QueueControls.define(queue, {
          globalConcurrency: 1,
          rateLimit: { max: 1, durationMs: 100 }
        })
      ]
    })
    const record = await resolve(firstControlled.reconcile(registry))
    await resolve(enqueue(first, 'shared-1', 'shared-controls'))
    await resolve(enqueue(first, 'shared-2', 'shared-controls'))

    const claims = await Promise.all(
      [
        firstControlled.claimControlled({
          queue: makeQueueName('shared-controls').unwrap(),
          accepted: [identity('shared-controls')],
          limit: 1,
          workerId: makeWorkerId('first').unwrap(),
          leaseDurationMs: 50,
          now: 0,
          controlsRevision: record.records[0]!.revision
        }),
        secondControlled.claimControlled({
          queue: makeQueueName('shared-controls').unwrap(),
          accepted: [identity('shared-controls')],
          limit: 1,
          workerId: makeWorkerId('second').unwrap(),
          leaseDurationMs: 50,
          now: 0,
          controlsRevision: record.records[0]!.revision
        })
      ].map(async (operation) => {
        const result = await operation
        return result
      })
    )
    const successful = claims.filter((result) => result.isOk()).map((result) => result.unwrap())
    expect(successful.filter((result) => result.jobs.length === 1)).toHaveLength(1)
    expect(
      claims.some((result) => Result.isOk(result) && result.value.reason === 'global-concurrency')
    ).toBe(true)

    const persisted = await resolve(secondControlled.get(makeQueueName('shared-controls').unwrap()))
    expect(persisted?.revision).toBe(1)
    const rateLimited = await resolve(
      secondControlled.claimControlled({
        queue: makeQueueName('shared-controls').unwrap(),
        accepted: [identity('shared-controls')],
        limit: 1,
        workerId: makeWorkerId('third').unwrap(),
        leaseDurationMs: 50,
        now: 1,
        controlsRevision: 1
      })
    )
    expect(rateLimited.reason).toBe('global-concurrency')
  })

  test('fails closed on stale revisions and releases only the owning permit after recovery', async () => {
    const config = makeStore()
    const store = SqliteJobStore.make(config)
    const controlled = store as unknown as ControlledJobStoreContract
    const queue = Queue.define('recovery-controls')
    const initial = await resolve(
      controlled.reconcile(
        QueueControls.registry({
          group: 'recovery-tests',
          controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
        })
      )
    )
    await resolve(enqueue(store, 'recovery-1', 'recovery-controls', 'tenant-a'))
    const claim = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('recovery-controls').unwrap(),
        accepted: [identity('recovery-controls')],
        limit: 1,
        workerId: makeWorkerId('recovery-1').unwrap(),
        leaseDurationMs: 5,
        now: 0,
        controlsRevision: initial.records[0]!.revision
      })
    )
    const token = claim.jobs[0]!.leaseToken
    const recovered = await resolve(
      controlled.recoverStalledControlled({
        queue: makeQueueName('recovery-controls').unwrap(),
        maxStalledCount: 1,
        limit: 1,
        now: 5,
        controlsRevision: 1
      })
    )
    expect(recovered.recovered).toBe(1)
    const redelivery = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('recovery-controls').unwrap(),
        accepted: [identity('recovery-controls')],
        limit: 1,
        workerId: makeWorkerId('recovery-2').unwrap(),
        leaseDurationMs: 5,
        now: 5,
        controlsRevision: 1
      })
    )
    expect(redelivery.jobs).toHaveLength(1)
    const staleRelease = await controlled.releaseControlled({
      jobId: redelivery.jobs[0]!.id,
      leaseToken: token,
      now: 6,
      controlsRevision: 1
    })
    expect(Result.isError(staleRelease)).toBe(true)

    const changed = await resolve(
      controlled.reconcile(
        QueueControls.registry({
          group: 'recovery-tests',
          controls: [QueueControls.define(queue, { globalConcurrency: 2 })]
        })
      )
    )
    const staleClaim = await controlled.claimControlled({
      queue: makeQueueName('recovery-controls').unwrap(),
      accepted: [identity('recovery-controls')],
      limit: 1,
      workerId: makeWorkerId('stale').unwrap(),
      leaseDurationMs: 5,
      now: 6,
      controlsRevision: initial.records[0]!.revision
    })
    expect(changed.updated[0]?.revision).toBe(2)
    expect(Result.isError(staleClaim)).toBe(true)
  })

  test('appends terminal child reports for controlled settlements atomically', async () => {
    const config = makeStore()
    const store = SqliteJobStore.make(config)
    const controlled = store as unknown as ControlledJobStoreContract
    const queue = Queue.define('controlled-flow')
    const controls = await resolve(
      controlled.reconcile(
        QueueControls.registry({
          group: 'controlled-flow-tests',
          controls: [QueueControls.define(queue, { globalConcurrency: 1 })]
        })
      )
    )
    const revision = controls.records[0]!.revision
    const parent = (flowId: string, childKey: string): string =>
      JSON.stringify({
        flowName: 'controlled-flow',
        flowId,
        childKey,
        parentStoreKey: 'controlled-parent',
        depth: 1
      })
    const attachParent = (id: string, flowId: string, childKey: string): void => {
      config.database
        .prepare('UPDATE better_effect_mq_jobs SET parent = ? WHERE namespace = ? AND id = ?')
        .run(parent(flowId, childKey), 'controlled', id)
    }

    await resolve(enqueue(store, 'controlled-settle', 'controlled-flow'))
    attachParent('controlled-settle', 'flow-settle', 'settle')
    const claimed = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('controlled-flow').unwrap(),
        accepted: [identity('controlled-flow')],
        limit: 1,
        workerId: makeWorkerId('controlled-worker').unwrap(),
        leaseDurationMs: 100,
        now: 1,
        controlsRevision: revision
      })
    )
    await resolve(
      controlled.settleControlled({
        jobId: claimed.jobs[0]!.id,
        leaseToken: claimed.jobs[0]!.leaseToken,
        outcome: { type: 'complete', result: { ok: true } },
        now: 2,
        controlsRevision: revision
      })
    )

    await resolve(enqueue(store, 'controlled-cancel', 'controlled-flow'))
    attachParent('controlled-cancel', 'flow-cancel', 'cancel')
    await resolve(
      controlled.cancelControlled({
        jobId: makeJobId('controlled-cancel').unwrap(),
        now: 3,
        controlsRevision: revision
      })
    )

    await resolve(enqueue(store, 'controlled-stalled', 'controlled-flow'))
    attachParent('controlled-stalled', 'flow-stalled', 'stalled')
    const stalledClaim = await resolve(
      controlled.claimControlled({
        queue: makeQueueName('controlled-flow').unwrap(),
        accepted: [identity('controlled-flow')],
        limit: 1,
        workerId: makeWorkerId('controlled-stalled-worker').unwrap(),
        leaseDurationMs: 1,
        now: 4,
        controlsRevision: revision
      })
    )
    await resolve(
      controlled.recoverStalledControlled({
        queue: makeQueueName('controlled-flow').unwrap(),
        maxStalledCount: 0,
        limit: 1,
        now: 5,
        controlsRevision: revision
      })
    )

    const reports = config.database
      .prepare('SELECT report_json FROM better_effect_mq_flow_outbox ORDER BY row_sequence')
      .all() as readonly { readonly report_json: string }[]
    expect(reports.map((row) => JSON.parse(row.report_json).outcome)).toEqual([
      'completed',
      'cancelled',
      'failed'
    ])
    expect(JSON.parse(reports[0]!.report_json)).toMatchObject({
      flowId: 'flow-settle',
      childKey: 'settle',
      result: { ok: true }
    })
    expect(JSON.parse(reports[2]!.report_json).failure.kind).toBe('stalled')
    expect(stalledClaim.jobs).toHaveLength(1)
  })
})
