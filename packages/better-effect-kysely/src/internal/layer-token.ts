import type { ServiceClass } from 'better-effect'

import type { KyselyServiceInstance, KyselyServiceToken } from '../types'

export const layerTokenFor = <Tag extends string, DB>(
  token: KyselyServiceToken<Tag, DB>
): ServiceClass<Tag, KyselyServiceInstance<Tag, DB>> => {
  // SAFETY: The generated token is a runtime constructor with a rejecting constructor; only Layer needs its concrete ServiceClass shape internally.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- This is the single checked Service/Layer erasure boundary.
  return token as unknown as ServiceClass<Tag, KyselyServiceInstance<Tag, DB>>
}
