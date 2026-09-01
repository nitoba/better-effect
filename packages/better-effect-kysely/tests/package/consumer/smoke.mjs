import * as KyselyEffect from 'better-effect-kysely'
import packageJson from 'better-effect-kysely/package.json' with { type: 'json' }

if (Object.keys(KyselyEffect).length !== 0) {
  throw new Error(`Unexpected foundation exports: ${Object.keys(KyselyEffect).join(', ')}`)
}

if (packageJson.name !== 'better-effect-kysely' || packageJson.version !== '0.1.0') {
  throw new Error('The packed Kysely foundation metadata is incorrect')
}

console.log('better-effect-kysely external consumer smoke passed')
