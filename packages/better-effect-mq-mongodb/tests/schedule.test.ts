// oxlint-disable anti-slop/no-runtime-typeof -- the exported API is checked at its public module boundary.

import { describe, expect, test } from 'bun:test'
import { MONGODB_LAYOUT_VERSION, collectionNames, MongoJobScheduleStore } from '../src/index'

describe('MongoDB schedule layout', () => {
  test('declares the schedule collection without changing protocol v1', () => {
    expect(MONGODB_LAYOUT_VERSION).toBe(4)
    expect(collectionNames('better_effect_mq')).toContain('better_effect_mq_schedules')
  })

  test('exports the associated JobScheduleStore adapter', () => {
    expect(typeof MongoJobScheduleStore.layer).toBe('function')
    expect(typeof MongoJobScheduleStore.layerFor).toBe('function')
    expect(typeof MongoJobScheduleStore.layerFromConfig).toBe('function')
    expect(typeof MongoJobScheduleStore.layerFromConfigFor).toBe('function')
  })
})
