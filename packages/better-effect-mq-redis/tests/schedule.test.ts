import { describe, expect, test } from 'bun:test'

import { loadRedisScriptManifest, makeRedisKeyLayout, redisHashSlot } from '../src/index'

describe('Redis schedule layout and scripts', () => {
  test('keeps schedule hashes and indexes in the namespace hash slot', () => {
    const layout = makeRedisKeyLayout('better-effect-mq', 'schedules')
    const keys = [
      layout.schedule('billing/service', 'monthly/invoices'),
      layout.scheduleGroup('billing/service'),
      layout.scheduleGroups,
      layout.scheduleDue
    ]

    expect(new Set(keys.map(redisHashSlot)).size).toBe(1)
    expect(layout.schedule('billing/service', 'monthly/invoices')).not.toBe(
      layout.schedule('billing/service', 'monthly:invoices')
    )
  })

  test('loads the atomic schedule tick script from the package manifest', async () => {
    const manifest = await loadRedisScriptManifest(new URL('../src/scripts/', import.meta.url))
    const definition = manifest.find((item) => item.name === 'tick-schedule')

    expect(definition?.version).toBe(1)
    expect(definition?.source).toContain('MQ_SCHEDULES_READY')
    expect(definition?.source).toContain('expectedRevision')
    expect(definition?.source).toContain('nextRunAtMs')
  })
})
