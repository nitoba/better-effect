// oxlint-disable anti-slop/no-unknown-returns -- the fake Redis driver models untyped replies.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- test fixtures assert controlled fake shapes.

import { describe, expect, test } from 'bun:test'
import { Result, type Result as ResultType } from 'better-result'
import {
  OutboxConflictError,
  OutboxId,
  OutboxStoreFailure,
  makeOutboxRecord,
  validatePreparedEnqueue
} from 'better-effect-mq-outbox'
import { RedisOutbox } from '../src'
import type { RedisCommandClient, RedisTransaction } from '../src'

type FakeTransaction = RedisTransaction & {
  readonly commands: readonly (readonly string[])[]
}

class TransactionClient implements RedisCommandClient {
  readonly calls: (readonly string[])[] = []
  readonly transactions: FakeTransaction[] = []
  discardCount = 0
  execCount = 0
  execReply: readonly unknown[] | null = [['inserted', '1']]
  execFailure: unknown = undefined
  private storedHash: Record<string, string> | undefined

  sendCommand(args: readonly string[]): Promise<unknown> {
    this.calls.push([...args])
    if (args[0] === 'EXISTS') return Promise.resolve(this.storedHash === undefined ? 0 : 1)
    if (args[0] === 'HGET') return Promise.resolve(this.storedHash?.[args[2]!] ?? null)
    if (args[0] === 'HGETALL') return Promise.resolve(this.storedHash ?? {})
    throw new Error(`unexpected direct command ${args[0]}`)
  }

  duplicate(): TransactionClient {
    return new TransactionClient()
  }

  multi(): FakeTransaction {
    const commands: (readonly string[])[] = []
    const transaction: FakeTransaction = {
      commands,
      sendCommand: (args) => {
        commands.push([...args])
        return transaction
      },
      exec: async () => {
        this.execCount += 1
        if (this.execFailure !== undefined) throw this.execFailure
        const append = commands.find((command) => command[0] === 'EVAL')
        if (append !== undefined && this.execReply?.[this.execReply.length - 1] instanceof Array) {
          const values = append.slice(7)
          this.storedHash = {
            id: values[0]!,
            requestDigest: values[1]!,
            target: values[2]!,
            state: values[3]!,
            request: values[4]!,
            attemptsMax: values[5]!,
            attemptsMade: values[6]!,
            runAtMs: values[7]!,
            createdAtMs: values[8]!,
            updatedAtMs: values[9]!,
            publishedAtMs: values[10]!,
            leaseOwner: values[11]!,
            leaseToken: values[12]!,
            leaseExpiresAtMs: values[13]!,
            failure: values[14]!,
            orderingSequence: '1',
            protocolVersion: values[16]!
          }
        }
        return this.execReply
      },
      discard: async () => {
        this.discardCount += 1
      }
    }
    this.transactions.push(transaction)
    return transaction
  }
}

const record = makeOutboxRecord({
  id: OutboxId.make('order-1').unwrap(),
  target: 'orders',
  request: validatePreparedEnqueue({
    protocolVersion: 1,
    identity: { queue: 'orders', name: 'send-confirmation', version: 1 },
    payload: { orderId: 'order-1' },
    metadata: {},
    priority: 0,
    runAt: 0,
    attemptsMax: 3,
    now: 0
  }).unwrap(),
  nowMs: 0
}).unwrap()

describe('RedisOutbox.transaction', () => {
  test('executes Redis-native writes and appends the outbox record in one MULTI/EXEC', async () => {
    const client = new TransactionClient()

    const result = await RedisOutbox.transaction(client, record, (transaction) => {
      transaction.sendCommand(['SET', 'orders:{order-1}', 'created'])
      return Result.ok('committed')
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) expect(result.value).toBe('committed')
    expect(client.execCount).toBe(1)
    expect(client.discardCount).toBe(0)
    expect(client.transactions[0]?.commands).toHaveLength(2)
    expect(client.transactions[0]?.commands[0]).toEqual(['SET', 'orders:{order-1}', 'created'])
    expect(client.transactions[0]?.commands[1]?.[0]).toBe('EVAL')
  })

  test('append is a convenience wrapper over the managed transaction boundary', async () => {
    const client = new TransactionClient()

    const result = await RedisOutbox.append(client, {
      id: record.id,
      target: record.target,
      request: record.request,
      nowMs: record.createdAtMs
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
      expect(result.value.duplicate).toBe(false)
      expect(result.value.record.id).toBe(record.id)
      expect(result.value.record.state).toBe('pending')
    }
  })

  test('rejects a digest conflict before queuing domain writes', async () => {
    const client = new TransactionClient()
    await RedisOutbox.append(client, {
      id: record.id,
      target: record.target,
      request: record.request,
      nowMs: record.createdAtMs
    })
    const conflicting = makeOutboxRecord({
      id: record.id,
      target: record.target,
      request: validatePreparedEnqueue({
        ...record.request,
        payload: { orderId: 'order-2' }
      }).unwrap(),
      nowMs: 0
    }).unwrap()

    const result = await RedisOutbox.transaction(client, conflicting, (transaction) => {
      transaction.sendCommand(['SET', 'orders:{order-1}', 'should-not-queue'])
      return 'not-committed'
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) expect(result.error).toBeInstanceOf(OutboxConflictError)
    expect(client.execCount).toBe(1)
    expect(client.transactions).toHaveLength(1)
  })

  test('discards queued commands when the callback returns a domain error', async () => {
    const client = new TransactionClient()
    const failure = new Error('domain rejected')

    const result = await RedisOutbox.transaction(client, record, (transaction) => {
      transaction.sendCommand(['SET', 'orders:{order-1}', 'should-not-commit'])
      return Result.err(failure) as ResultType<never, Error>
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) expect(result.error as unknown).toBe(failure)
    expect(client.execCount).toBe(0)
    expect(client.discardCount).toBe(1)
  })

  test('discards queued commands when the callback throws', async () => {
    const client = new TransactionClient()
    const failure = new Error('domain threw')

    const result = await RedisOutbox.transaction(client, record, () => {
      throw failure
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) expect(result.error as unknown).toBe(failure)
    expect(client.execCount).toBe(0)
    expect(client.discardCount).toBe(1)
  })

  test('surfaces an append/EXEC failure without pretending Redis rolled back', async () => {
    const client = new TransactionClient()
    client.execReply = [['ok'], ['error', 'append rejected']]

    const result = await RedisOutbox.transaction(client, record, (transaction) => {
      transaction.sendCommand(['SET', 'orders:{order-1}', 'created'])
      return 'committed'
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(OutboxStoreFailure)
      expect((result.error as OutboxStoreFailure).operation).toBe('transaction')
    }
    expect(client.execCount).toBe(1)
    expect(client.discardCount).toBe(0)
  })

  test('cleans up a transaction that Redis reports as aborted', async () => {
    const client = new TransactionClient()
    client.execReply = null

    const result = await RedisOutbox.transaction(client, record, (transaction) => {
      transaction.sendCommand(['SET', 'orders:{order-1}', 'created'])
      return 'aborted'
    })

    expect(Result.isError(result)).toBe(true)
    expect(client.execCount).toBe(1)
    expect(client.discardCount).toBe(1)
  })
})
