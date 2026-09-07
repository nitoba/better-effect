import { expectTypeOf } from 'bun:test'

import {
  JobId,
  MemoryJobStore,
  protocolVersion,
  protocolVersionV2,
  type JobStore,
  type JobStoreContract,
  type JobStoreV2,
  type JobStoreV2Contract,
  type JobStoreV2Descriptor
} from '../../src'

const store = MemoryJobStore.make()
const v2: JobStoreV2 = store.v2

expectTypeOf(v2).toEqualTypeOf<JobStoreV2Contract>()
expectTypeOf(v2).toEqualTypeOf<JobStore.V2>()
expectTypeOf(v2.descriptor).toEqualTypeOf<JobStoreV2Descriptor>()
expectTypeOf(v2.descriptor.protocolVersion).toEqualTypeOf<2>()
expectTypeOf(v2.getJob({ jobId: JobId.make('job').unwrap() })).toMatchTypeOf<
  ReturnType<JobStoreV2Contract['getJob']>
>()
expectTypeOf(protocolVersion).toEqualTypeOf<1>()
expectTypeOf(protocolVersionV2).toEqualTypeOf<2>()

// A v1 structural adapter does not need to opt into v2.
declare const v1: JobStoreContract
expectTypeOf(v1).toMatchTypeOf<JobStore.Contract>()

void store
void v2
void v1
