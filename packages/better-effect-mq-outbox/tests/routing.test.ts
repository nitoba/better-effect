import { expect, test } from 'bun:test'

import { JobStore } from 'better-effect-mq'

import { OutboxDefinitionError, OutboxRoutes } from '../src'

test('OutboxRoutes resolves explicit target tokens', () => {
  const jobs = JobStore.named('jobs')
  const routes = OutboxRoutes.make({
    postgres: jobs
  })

  expect(routes.get('postgres')).toBe(jobs)
  expect(routes.get('missing')).toBeUndefined()
  expect(routes.entries).toEqual([{ target: 'postgres', store: jobs }])
})

test('OutboxRoutes rejects duplicate targets in ordered entries', () => {
  const jobs = JobStore.named('jobs')

  expect(() =>
    OutboxRoutes.make([
      { target: 'orders', store: jobs },
      { target: 'orders', store: jobs }
    ])
  ).toThrow(OutboxDefinitionError)
})

test('OutboxRoutes rejects invalid targets', () => {
  const jobs = JobStore.named('jobs')

  expect(() => OutboxRoutes.make({ '': jobs })).toThrow(OutboxDefinitionError)
  expect(() => OutboxRoutes.make([{ target: 'bad\u0000target', store: jobs }])).toThrow(
    OutboxDefinitionError
  )
})
