import type { NextEffectRouteOptions } from 'better-effect/next'

type Context = { readonly params: Promise<{ readonly id: string }> }

const respond = () => new Response('ok')
const serialize = () => null

const respondAndSerialize = {
  respond,
  serialize
}
const respondAndOnSuccess = {
  respond,
  onSuccess: respond
}
const serializeAndOnSuccess = {
  serialize,
  onSuccess: respond
}

// @ts-expect-error Route success policies are mutually exclusive.
const invalidRespondSerialize: NextEffectRouteOptions<string, Context> = respondAndSerialize
// @ts-expect-error Route success policies are mutually exclusive.
const invalidRespondOnSuccess: NextEffectRouteOptions<string, Context> = respondAndOnSuccess
// @ts-expect-error Route success policies are mutually exclusive.
const invalidSerializeOnSuccess: NextEffectRouteOptions<string, Context> = serializeAndOnSuccess

void invalidRespondSerialize
void invalidRespondOnSuccess
void invalidSerializeOnSuccess
