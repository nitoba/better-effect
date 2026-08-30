import { Layer } from 'better-effect'
import type { BetterAuthService, BetterAuthServiceInstance } from 'better-effect-better-auth'

import type { Assert, Equal } from './assert'
import { Auth, authWithPlugins } from './auth'

type AuthInstance = BetterAuthServiceInstance<'@public-types/Auth', typeof authWithPlugins>

declare const implementation: BetterAuthService<typeof authWithPlugins>
const replacement = Auth.of(implementation)
const replacementLayer = Layer.succeed(Auth, replacement)
const overridden = Layer.override(Auth.layer, replacementLayer)

type _Replacement = Assert<Equal<typeof replacement, AuthInstance>>
type _ReplacementLayer = Assert<Equal<Layer.Provided<typeof replacementLayer>, AuthInstance>>
type _Overridden = Assert<Equal<Layer.Provided<typeof overridden>, AuthInstance>>

void overridden
