import { expectTypeOf } from 'bun:test'

import { Result, type Result as ResultType, type UnhandledException } from 'better-result'

import { Resource, ResourceReleaseFailure } from '../../src/resource'

type AcquireFailure = {
  readonly _tag: 'AcquireFailure'
}

type UseFailure = {
  readonly _tag: 'UseFailure'
}

type TestResource = {
  readonly value: number
}

const result = Resource.acquireUseRelease({
  name: 'resource',

  acquire: () =>
    Result.ok<TestResource, AcquireFailure>({
      value: 42
    }),

  use: (resource) => Result.ok<number, UseFailure>(resource.value)
})

type Expected = Promise<
  ResultType<number, AcquireFailure | UseFailure | UnhandledException | ResourceReleaseFailure>
>

expectTypeOf(result).toEqualTypeOf<Expected>()
