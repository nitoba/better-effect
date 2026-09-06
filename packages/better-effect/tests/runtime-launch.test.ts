import { describe, expect, test } from 'bun:test'

import { Layer } from '../src'
import { NodeRuntime } from '../src/node'

describe('NodeRuntime.launch', () => {
  test('keeps one Runtime alive until caller abort and then releases it', async () => {
    const controller = new AbortController()
    const events: string[] = []
    const launched = NodeRuntime.launch(
      Layer.scopedDiscard(
        () => {
          events.push('acquire')
          return {}
        },
        {
          quiesce: () => {
            events.push('quiesce')
          },
          release: () => {
            events.push('release')
          }
        }
      ),
      { signal: controller.signal }
    )

    await Promise.resolve()
    expect(events).toEqual(['acquire'])

    controller.abort(new Error('stop'))
    await launched

    expect(events).toEqual(['acquire', 'quiesce', 'release'])
  })
})
