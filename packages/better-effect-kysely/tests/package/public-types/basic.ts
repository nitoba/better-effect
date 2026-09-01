import * as KyselyEffect from 'better-effect-kysely'

type Assert<Condition extends true> = Condition
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false

type _PublishedFoundationHasNoRuntimeExports = Assert<Equal<keyof typeof KyselyEffect, never>>

void KyselyEffect
