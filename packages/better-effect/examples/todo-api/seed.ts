import { Result } from 'better-result'

import { Effect } from './better-effect'
import { PasswordHasher } from './password-hasher'
import { UserRepository } from './repositories/user-repository'

export const seedDemoUser = Effect.fn(async function* () {
  const users = yield* UserRepository

  const passwordHasher = yield* PasswordHasher

  const email = 'demo@example.com'

  const existing = yield* Result.await(users.findByEmail(email))

  if (existing) {
    return Result.ok(existing)
  }

  const passwordHash = yield* Result.await(passwordHasher.hash('demo1234'))

  const user = yield* Result.await(
    users.create({
      id: Bun.randomUUIDv7(),
      email,
      passwordHash,
      createdAt: new Date().toISOString()
    })
  )

  return Result.ok(user)
})
