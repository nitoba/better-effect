import * as Http from 'better-effect-http'
import { HttpTest } from 'better-effect-http/testing'
import packageJson from 'better-effect-http/package.json' with { type: 'json' }

for (const exportName of ['HttpRequest', 'HttpRequestError', 'HttpClient', 'validateHttpOptions']) {
  if (!(exportName in Http)) {
    throw new Error(`Missing public HTTP foundation export: ${exportName}`)
  }
}

if (packageJson.name !== 'better-effect-http' || packageJson.version !== '0.1.0') {
  throw new Error('The packed HTTP package manifest is not the expected artifact')
}

const scenario = HttpTest.sequence([HttpTest.response(200, { ok: true })])
const response = await scenario.fetch('https://example.test/health')
if (response.status !== 200 || scenario.calls !== 1) {
  throw new Error('The packed HTTP testing subpath is not functional')
}

console.log(`better-effect-http external consumer passed with ${packageJson.version}`)
