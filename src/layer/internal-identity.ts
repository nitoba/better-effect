import type { AnyServiceToken } from '../service'

import { ServiceTagCollisionError } from './errors'

const serviceMemberNames = (token: AnyServiceToken): readonly (string | symbol)[] => {
  const names = new Set<string | symbol>()
  let prototype = token.prototype

  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor') {
        names.add(name)
      }
    }

    for (const symbol of Object.getOwnPropertySymbols(prototype)) {
      names.add(symbol)
    }

    prototype = Object.getPrototypeOf(prototype)
  }

  return [...names]
}

/**
 * Check the runtime portion of a same-tag association before returning it.
 * TypeScript remains authoritative for full structural compatibility; this
 * check catches the common incompatible-method collision after erasure.
 */
export const assertServiceCompatibility = (
  requested: AnyServiceToken,
  registered: AnyServiceToken,
  instance: unknown
): void => {
  if (requested === registered || requested.serviceTag !== registered.serviceTag) {
    return
  }

  if ((typeof instance !== 'object' && typeof instance !== 'function') || instance === null) {
    throw new ServiceTagCollisionError(registered, requested)
  }

  for (const name of serviceMemberNames(requested)) {
    if (!(name in instance)) {
      throw new ServiceTagCollisionError(registered, requested)
    }
  }
}
