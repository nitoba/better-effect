import { Result } from 'better-result'

import { Effect, Service } from '../better-effect'
import { Database } from '../database'
import type { User } from '../domain'

type UserRow = {
  id: string
  email: string
  password_hash: string
  created_at: string
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  createdAt: row.created_at
})

export class UserRepository extends Service<UserRepository>()('UserRepository') {
  findByEmail(email: string) {
    return Effect.gen(async function* () {
      const database = yield* Database

      const rows = yield* Result.await(
        database.run(
          'user.findByEmail',
          // SAFETY: The SQL projection matches every field declared by UserRow.
          async (sql) =>
            (await sql`
                  SELECT
                    id,
                    email,
                    password_hash,
                    created_at
                  FROM users
                  WHERE email = ${email}
                  LIMIT 1
                `) as UserRow[]
        )
      )

      return Result.ok(rows[0] ? toUser(rows[0]) : null)
    })
  }

  create(user: User) {
    return Effect.gen(async function* () {
      const database = yield* Database

      yield* Result.await(
        database.run('user.create', async (sql) => {
          await sql`
                INSERT INTO users (
                  id,
                  email,
                  password_hash,
                  created_at
                )
                VALUES (
                  ${user.id},
                  ${user.email},
                  ${user.passwordHash},
                  ${user.createdAt}
                )
              `
        })
      )

      return Result.ok(user)
    })
  }
}
