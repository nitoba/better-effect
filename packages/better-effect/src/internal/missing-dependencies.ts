import type { AnyService } from '../service'

export type MissingDependencies<Missing extends AnyService> = {
  /** Names the Services that must be supplied before execution. */
  readonly missingServices: Missing
}
