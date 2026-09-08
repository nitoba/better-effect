import { appendMongoJobEvent, assertMongoJobEventWriterReady } from './event-store'
import type { JobEventStoreWriter, DurableJobEventInput } from 'better-effect-mq'
import type { MongoSession } from './config'
import type { MongoCollections } from './collections'

export const assertMongoExtensionEventWriterReady = async (
  session: MongoSession,
  collections: MongoCollections,
  namespace: string,
  operation: string,
  writer: JobEventStoreWriter | undefined
): Promise<void> => {
  if (writer === undefined) return
  await assertMongoJobEventWriterReady(session, collections, namespace, operation, writer)
}

export const appendMongoExtensionEvent = async (
  session: MongoSession,
  collections: MongoCollections,
  namespace: string,
  writer: JobEventStoreWriter | undefined,
  input: DurableJobEventInput
): Promise<void> => {
  if (writer?.canAppend !== true) return
  await appendMongoJobEvent(session, collections, namespace, input)
}
