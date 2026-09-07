import * as Http from '../../src'

type ExportedNames = keyof typeof Http

const noPublicApiYet: ExportedNames extends never ? true : never = true

void noPublicApiYet
