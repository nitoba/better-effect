import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { HttpClient } from 'better-effect-http'

import { number, object, schema, string, streamResponse, withLocalServer } from './support'

const progress = schema((value) => {
  const percent = number(object(value)?.['percent'])
  return percent === undefined ? undefined : { percent }
})
const completed = schema((value) => {
  const jobId = string(object(value)?.['jobId'])
  return jobId === undefined ? undefined : { jobId }
})

let connections = 0
const seenBusinessEvents = new Set<string>()
let persistedProtocolCursor = 'checkpoint-0'

await withLocalServer(
  (request) => {
    connections++
    const resumed = request.headers.get('last-event-id') === 'step-1'
    return streamResponse(
      resumed
        ? [
            'event: progress\ndata: {"percent":50}\nid: step-1\n\n',
            'event: completed\ndata: {"jobId":"job-1"}\nid: done\n\n'
          ]
        : ['event: progress\ndata: {"percent":50}\nid: step-1\n\n'],
      { 'content-type': 'text/event-stream' }
    )
  },
  async (baseURL) => {
    const runtime = await Runtime.make(HttpClient.layer({ baseURL }))
    try {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const http = yield* HttpClient
          const subscription = http.sse('/jobs/job-1/events', {
            events: { progress, completed },
            lastEventId: persistedProtocolCursor,
            reconnect: {
              times: 1,
              delay: () => 0,
              resume: 'last-event-id',
              onEnd: 'reconnect'
            }
          })
          const percentages: number[] = []
          const terminal = yield* subscription.takeUntil(
            (message) => {
              const eventId = message.id ?? message.lastEventId
              // A protocol cursor is not an exactly-once business checkpoint. The
              // application persists its own idempotency key and deduplicates here.
              if (!seenBusinessEvents.has(eventId)) {
                seenBusinessEvents.add(eventId)
                persistedProtocolCursor = message.lastEventId
                if (message.event === 'progress') percentages.push(message.data.percent)
              }
              return message.event === 'completed'
            },
            { requireMatch: true }
          )
          if (Result.isError(terminal)) return terminal
          if (terminal.value.event !== 'completed') return Result.err(new Error('wrong terminal'))
          return Result.ok({ connections, percentages, jobId: terminal.value.data.jobId })
        })
      )

      if (Result.isError(result)) throw result.error
      if (result.value.connections !== 2 || result.value.jobId !== 'job-1')
        throw new Error('SSE did not resume within its opening budget')
      console.log(JSON.stringify(result.value))
    } finally {
      await runtime.dispose()
    }
  }
)
