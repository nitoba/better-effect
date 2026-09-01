import * as KyselyEffect from 'better-effect-kysely'
import packageJson from 'better-effect-kysely/package.json' with { type: 'json' }

type Assert<Condition extends true> = Condition
type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false

type _NoFunctionalPlaceholder = Assert<Equal<keyof typeof KyselyEffect, never>>
const packageName: string = packageJson.name
const packageVersion: string = packageJson.version

void KyselyEffect
void packageName
void packageVersion
