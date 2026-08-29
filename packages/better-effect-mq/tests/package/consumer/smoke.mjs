import { JobId, protocolVersion } from 'better-effect-mq'
import * as core from 'better-effect-mq'
import * as testing from 'better-effect-mq/testing'
import packageJson from 'better-effect-mq/package.json' with { type: 'json' }

if (Object.keys(core).length === 0 || protocolVersion !== 1) {
  throw new Error('the better-effect-mq protocol entrypoint did not resolve')
}

if (JobId.make === undefined) {
  throw new Error('the better-effect-mq protocol brand constructor did not resolve')
}

if (Object.keys(testing).length !== 0) {
  throw new Error('the better-effect-mq testing entrypoint is not inert')
}

if (packageJson.name !== 'better-effect-mq') {
  throw new Error('the package.json export did not resolve from the tarball')
}

console.log('better-effect-mq external consumer smoke test passed')
