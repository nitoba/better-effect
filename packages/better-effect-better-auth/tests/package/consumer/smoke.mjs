import * as publicApi from 'better-effect-better-auth'

if (Object.keys(publicApi).length !== 0) {
  throw new Error('The package exposed provisional runtime symbols')
}
