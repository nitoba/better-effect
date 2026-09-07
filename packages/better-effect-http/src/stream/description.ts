import type { TransportOptions, TransportRequestOptions } from '../internal/ofetch-transport'
import { executeRequest } from '../internal/ofetch-transport'
import { StreamSession } from './session'

export type HttpStream<A = Uint8Array, E = unknown, R = never> = Readonly<{
  readonly _A?: A
  readonly _E?: E
  readonly _R?: R
  readonly request: Readonly<{
    readonly method: string
    readonly path: string
    readonly options: TransportRequestOptions
  }>
}>

export const stream = (
  config: TransportOptions,
  path: string,
  options: TransportRequestOptions = {}
): HttpStream<Uint8Array, unknown, never> =>
  Object.freeze({ request: Object.freeze({ method: 'GET', path, options: { ...options } }) })

export const openStream = async (
  config: TransportOptions,
  description: HttpStream<Uint8Array, unknown, never>
): Promise<StreamSession> => StreamSession.make(await executeRequest(config, description.request))
