import { Layer } from '../layer'
import { Service } from '../service'

/** Execution-local request value carried by a normal Service provider. */
export class CurrentRequest extends Service<CurrentRequest>()('CurrentRequest') {
  readonly request: unknown

  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  constructor(readonly value: unknown) {
    super()
    this.request = value
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  static layer(value: unknown) {
    return Layer.succeed(CurrentRequest, new CurrentRequest(value))
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const CurrentRequestLayer = (value: unknown) => CurrentRequest.layer(value)
