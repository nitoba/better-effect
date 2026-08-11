import { Result } from 'better-result'

import { Effect, Service } from '../better-effect'
import type { LoginInput, LoginOutput, Session } from '../domain'
import { InvalidCredentials, Unauthorized } from '../errors'
import { PasswordHasher } from '../password-hasher'
import { SessionRepository } from '../repositories/session-repository'
import { UserRepository } from '../repositories/user-repository'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 1 day

export class AuthService extends Service<AuthService>() {
  login(input: LoginInput) {
    return Effect.gen(async function* () {
      const users = yield* UserRepository

      const sessions = yield* SessionRepository

      const passwordHasher = yield* PasswordHasher

      const user = yield* Result.await(users.findByEmail(input.email))

      if (!user) {
        return Result.err(
          new InvalidCredentials({
            message: 'Invalid email or password'
          })
        )
      }

      const passwordMatches = yield* Result.await(
        passwordHasher.verify(input.password, user.passwordHash)
      )

      if (!passwordMatches) {
        return Result.err(
          new InvalidCredentials({
            message: 'Invalid email or password'
          })
        )
      }

      const session: Session = {
        token: Bun.randomUUIDv7(),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
      }

      yield* Result.await(sessions.create(session))

      const output: LoginOutput = {
        token: session.token,
        expiresAt: session.expiresAt,
        user: {
          id: user.id,
          email: user.email
        }
      }

      return Result.ok(output)
    })
  }

  authenticate(token: string) {
    return Effect.gen(async function* () {
      const sessions = yield* SessionRepository

      const session = yield* Result.await(
        sessions.findValidByToken(token, new Date().toISOString())
      )

      if (!session) {
        return Result.err(
          new Unauthorized({
            message: 'Invalid or expired session'
          })
        )
      }

      return Result.ok({
        userId: session.userId
      })
    })
  }
}
