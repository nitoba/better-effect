import * as publicApi from 'better-effect-better-auth'

type ExpectNever<Value extends never> = Value
type PublicKeys = keyof typeof publicApi

type _NoProvisionalExports = ExpectNever<PublicKeys>
