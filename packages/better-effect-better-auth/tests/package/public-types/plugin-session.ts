import { BetterAuth, type BetterAuthSessionOf } from 'better-effect-better-auth'

import type { Assert, Equal, IsAssignable } from './assert'
import { authWithPlugins } from './auth'

type Auth = typeof authWithPlugins
type Session = BetterAuthSessionOf<Auth>
type User = Session['user']
type SessionRecord = Session['session']
type Codes = BetterAuth.ErrorCode<Auth>

type _UserPluginField = Assert<IsAssignable<'plan', keyof User>>
type _SessionPluginField = Assert<IsAssignable<'tenantId', keyof SessionRecord>>
type _UserPluginFieldIsString = Assert<Equal<User['plan'], string | null | undefined>>
type _SessionPluginFieldIsString = Assert<
  Equal<SessionRecord['tenantId'], string | null | undefined>
>
type _PluginCode = Assert<IsAssignable<'CUSTOM_PLUGIN_FAILURE', Codes>>

declare const user: User
declare const session: SessionRecord

user.plan satisfies string | null | undefined
session.tenantId satisfies string | null | undefined
