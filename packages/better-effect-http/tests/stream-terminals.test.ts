import { Result } from 'better-result'
import { expect, test } from 'bun:test'
import { Scope } from 'better-effect'
import { HttpStreamUnexpectedEndError, StreamSession, pipeTo, takeUntil, use } from '../src/stream'

const sessionFor = async (values: readonly number[]) =>
  StreamSession.make(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const value of values) controller.enqueue(new Uint8Array([value]))
          controller.close()
        }
      }),
      { status: 200 }
    )
  )

test('takeUntil includes the matching item and closes the session', async () => {
  await Scope.run(async () => {
    const result = await takeUntil(
      await sessionFor([1, 2, 3]),
      (value: Uint8Array) => value[0] === 2
    ).next()
    expect(result.value).toEqual(Result.ok(new Uint8Array([2])))
  })
})

test('takeUntil requireMatch reports an early EOF', async () => {
  await Scope.run(async () => {
    const result = await takeUntil(await sessionFor([1]), () => false, {
      requireMatch: true
    }).next()
    expect(result.value).toMatchObject({ error: { _tag: 'HttpStreamUnexpectedEndError' } })
    expect(result.value && Result.isError(result.value) && result.value.error).toBeInstanceOf(
      HttpStreamUnexpectedEndError
    )
  })
})

test('use exposes the body and always closes the session', async () => {
  await Scope.run(async () => {
    let body: ReadableStream<Uint8Array> | undefined
    const result = await use(await sessionFor([1]), (session) => {
      body = session.body
      return Result.ok('done')
    }).next()
    expect(result.value).toEqual(Result.ok('done'))
    expect(body).toBeInstanceOf(ReadableStream)
  })
})

test('pipeTo writes incrementally and honors preventClose', async () => {
  await Scope.run(async () => {
    const values: number[] = []
    let closed = false
    const destination = new WritableStream<Uint8Array>({
      write(chunk) {
        values.push(chunk[0]!)
      },
      close() {
        closed = true
      }
    })
    const result = await pipeTo(await sessionFor([1, 2]), destination, {
      preventClose: true
    }).next()
    expect(result.value).toEqual(Result.ok(undefined))
    expect(values).toEqual([1, 2])
    expect(closed).toBe(false)
  })
})
