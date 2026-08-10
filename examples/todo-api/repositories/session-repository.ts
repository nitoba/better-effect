import { Result } from 'better-result'

import { Service } from '../better-effect'
import { Database } from '../database'
import type { Session } from '../domain'

type SessionRow = {
  token: string
  user_id: string
  expires_at: string
}

const toSession = (row: SessionRow): Session => ({
  token: row.token,
  userId: row.user_id,
  expiresAt: row.expires_at
})

export class SessionRepository extends Service<SessionRepository>() {
  create(session: Session) {
    return Result.gen(async function* () {
      const database = yield* Database

      yield* Result.await(
        database.run('session.create', async (sql) => {
          await sql`
                INSERT INTO sessions (
                  token,
                  user_id,
                  expires_at
                )
                VALUES (
                  ${session.token},
                  ${session.userId},
                  ${session.expiresAt}
                )
              `
        })
      )

      return Result.ok(session)
    })
  }

  findValidByToken(token: string, now: string) {
    return Result.gen(async function* () {
      const database = yield* Database

      const rows = yield* Result.await(
        database.run(
          'session.findValidByToken',
          async (sql) =>
            (await sql`
                  SELECT
                    token,
                    user_id,
                    expires_at
                  FROM sessions
                  WHERE token = ${token}
                    AND expires_at > ${now}
                  LIMIT 1
                `) as SessionRow[]
        )
      )

      return Result.ok(rows[0] ? toSession(rows[0]) : null)
    })
  }
}
