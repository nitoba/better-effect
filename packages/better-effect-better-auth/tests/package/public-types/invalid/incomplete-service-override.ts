import { BetterAuth } from 'better-effect-better-auth'

import { authWithPlugins } from '../auth'

const Auth = BetterAuth.service('@invalid/IncompleteOverride', authWithPlugins)
type Service = BetterAuth.Service<typeof authWithPlugins>
declare const api: Service['api']

Auth.of({
  api,
  raw: authWithPlugins
})
