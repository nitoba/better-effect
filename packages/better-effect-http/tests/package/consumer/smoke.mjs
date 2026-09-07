import * as Http from 'better-effect-http'
import packageJson from 'better-effect-http/package.json' with { type: 'json' }

if (Object.keys(Http).length !== 0) {
  throw new Error('The initial HTTP package must not expose a placeholder API')
}

if (packageJson.name !== 'better-effect-http' || packageJson.version !== '0.1.0') {
  throw new Error('The packed HTTP package manifest is not the expected artifact')
}

console.log(`better-effect-http external consumer passed with ${packageJson.version}`)
