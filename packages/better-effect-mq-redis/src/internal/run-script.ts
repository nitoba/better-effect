// oxlint-disable anti-slop/no-unknown-parameters -- the decoder is the explicit reply-validation boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- replies remain unknown until the supplied decoder validates them.
import { Result, type Result as ResultType } from 'better-result'
import { RedisScriptRegistry, type RedisScriptName } from '../script-registry'
import { redactedRedisError } from '../errors'

export interface RedisScriptInvocation<T> {
  readonly keys: readonly string[]
  readonly args?: readonly string[]
  readonly decode: (reply: unknown) => T
}

/** The one script boundary: execute, then decode Redis's untyped reply. */
export const runScript = async <T>(
  registry: RedisScriptRegistry,
  name: RedisScriptName,
  invocation: RedisScriptInvocation<T>
): Promise<ResultType<T, unknown>> => {
  try {
    const reply = await registry.execute(name, invocation.keys, invocation.args ?? [])
    return Result.ok(invocation.decode(reply)) as ResultType<T, unknown>
  } catch (cause) {
    return Result.err(redactedRedisError(`${name} script`, cause)) as ResultType<T, unknown>
  }
}
