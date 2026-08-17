import type { AnyService } from '../service'

declare const MissingDependenciesTypeId: unique symbol

export type MissingDependencies<Missing extends AnyService> = {
  readonly [MissingDependenciesTypeId]: Missing
}
