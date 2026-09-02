import { Codec, Queue, Retry } from 'better-effect-mq'

export const Emails = Queue.define('examples.emails')

export const SendEmail = Emails.job('send-email', {
  version: 1,
  payload: Codec.json<{
    readonly messageId: string
    readonly recipient: string
  }>(),
  result: Codec.string,
  failure: Codec.json<{ readonly code: string }>(),
  defaults: {
    attempts: 2,
    backoff: Retry.fixed({ delayMs: 1, maxAttempts: 2 }),
    timeoutMs: 5_000
  },
  idempotencyKey: ({ messageId }) => messageId,
  retryable: ({ code }) => code !== 'invalid-recipient'
})
