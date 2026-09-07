import * as Http from 'better-effect-http'
import packageJson from 'better-effect-http/package.json' with { type: 'json' }

for (const exportName of ['HttpRequest', 'HttpRequestError', 'HttpClient', 'validateHttpOptions']) {
  if (!(exportName in Http)) {
    throw new Error(`Missing public HTTP foundation export: ${exportName}`)
  }
}

if (packageJson.name !== 'better-effect-http' || packageJson.version !== '0.1.0') {
  throw new Error('The packed HTTP package manifest is not the expected artifact')
}

console.log(`better-effect-http external consumer passed with ${packageJson.version}`)
