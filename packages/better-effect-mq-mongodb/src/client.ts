// oxlint-disable anti-slop/no-runtime-typeof -- caller-owned client capability is checked at the public boundary.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- official driver and normalized config values are narrowed immediately.

import { Service } from 'better-effect'
import {
  normalizeMongoJobStoreConfig,
  normalizeMongoJobStoreConnectionConfig,
  type MongoClient,
  type MongoDb,
  type MongoJobStoreConfig,
  type MongoJobStoreConnectionConfig
} from './config'
import { MongoJobStoreConfigurationError, redactedMongoError } from './errors'

export class MongoJobStoreClient extends Service<MongoJobStoreClient>()('MongoJobStoreClient') {
  readonly db: MongoDb
  readonly client: MongoClient
  readonly ownsClient: boolean
  readonly namespace: string
  readonly collectionPrefix: string
  readonly validateLayout: boolean
  readonly notifications: 'auto' | 'poll'
  private disposal: Promise<void> | undefined

  private constructor(
    config: ReturnType<typeof normalizeMongoJobStoreConfig>,
    client: MongoClient,
    ownsClient: boolean
  ) {
    super()
    this.db = config.db
    this.client = client
    this.ownsClient = ownsClient
    this.namespace = config.namespace
    this.collectionPrefix = config.collectionPrefix
    this.validateLayout = config.validateLayout
    this.notifications = config.notifications
  }

  static fromDb(config: MongoJobStoreConfig): MongoJobStoreClient {
    const normalized = normalizeMongoJobStoreConfig(config)
    const client = normalized.db.client
    if (client === undefined || typeof client.startSession !== 'function') {
      throw new MongoJobStoreConfigurationError(
        'db must expose its owning MongoClient through db.client for transaction sessions',
        'db'
      )
    }
    return new MongoJobStoreClient(normalized, client, false)
  }

  static async fromConfig(config: MongoJobStoreConnectionConfig): Promise<MongoJobStoreClient> {
    const normalized = normalizeMongoJobStoreConnectionConfig(config)
    let client: MongoClient | undefined
    try {
      // Keep the official driver an optional peer: package import and caller-owned Db usage never load it.
      const driver = await import('mongodb')
      client = new driver.MongoClient(normalized.uri, normalized.clientOptions)
      const db = (client as MongoClient & { db(name: string): MongoDb }).db(normalized.database)
      return new MongoJobStoreClient(
        normalizeMongoJobStoreConfig({
          db,
          namespace: normalized.namespace,
          collectionPrefix: normalized.collectionPrefix,
          validateLayout: normalized.validateLayout as boolean,
          notifications: normalized.notifications as 'auto' | 'poll'
        }),
        client,
        true
      )
    } catch (cause) {
      try {
        await client?.close()
      } catch {
        /* setup error remains primary */
      }
      throw redactedMongoError('client configuration', cause)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposal = this.ownsClient ? this.client.close() : Promise.resolve()
    return this.disposal
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
  }
}
