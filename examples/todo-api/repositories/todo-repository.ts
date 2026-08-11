import { Result } from 'better-result'

import { Effect, Service } from '../better-effect'
import { Database } from '../database'
import type { CreateTodoInput, Todo, UpdateTodoInput } from '../domain'

type TodoRow = {
  id: string
  user_id: string
  title: string
  completed: number
  created_at: string
  updated_at: string
}

const toTodo = (row: TodoRow): Todo => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  completed: Boolean(row.completed),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

export class TodoRepository extends Service<TodoRepository>() {
  list(userId: string) {
    return Effect.gen(async function* () {
      const database = yield* Database

      const rows = yield* Result.await(
        database.run(
          'todo.list',
          async (sql) =>
            (await sql`
                  SELECT
                    id,
                    user_id,
                    title,
                    completed,
                    created_at,
                    updated_at
                  FROM todos
                  WHERE user_id = ${userId}
                  ORDER BY created_at DESC
                `) as TodoRow[]
        )
      )

      return Result.ok(rows.map(toTodo))
    })
  }

  findById(userId: string, id: string) {
    return Effect.gen(async function* () {
      const database = yield* Database

      const rows = yield* Result.await(
        database.run(
          'todo.findById',
          async (sql) =>
            (await sql`
                  SELECT
                    id,
                    user_id,
                    title,
                    completed,
                    created_at,
                    updated_at
                  FROM todos
                  WHERE id = ${id}
                    AND user_id = ${userId}
                  LIMIT 1
                `) as TodoRow[]
        )
      )

      return Result.ok(rows[0] ? toTodo(rows[0]) : null)
    })
  }

  create(userId: string, input: CreateTodoInput) {
    return Effect.gen(async function* () {
      const database = yield* Database

      const id = crypto.randomUUID()

      const now = new Date().toISOString()

      const rows = yield* Result.await(
        database.run(
          'todo.create',
          async (sql) =>
            (await sql`
                  INSERT INTO todos (
                    id,
                    user_id,
                    title,
                    completed,
                    created_at,
                    updated_at
                  )
                  VALUES (
                    ${id},
                    ${userId},
                    ${input.title},
                    ${0},
                    ${now},
                    ${now}
                  )
                  RETURNING
                    id,
                    user_id,
                    title,
                    completed,
                    created_at,
                    updated_at
                `) as TodoRow[]
        )
      )

      return Result.ok(toTodo(rows[0]!))
    })
  }

  update(userId: string, id: string, input: UpdateTodoInput) {
    return Effect.gen(async function* () {
      const database = yield* Database

      const title = input.title ?? null

      const completed = input.completed === undefined ? null : Number(input.completed)

      const updatedAt = new Date().toISOString()

      const rows = yield* Result.await(
        database.run(
          'todo.update',
          async (sql) =>
            (await sql`
                  UPDATE todos
                  SET
                    title =
                      COALESCE(
                        ${title},
                        title
                      ),
                    completed =
                      COALESCE(
                        ${completed},
                        completed
                      ),
                    updated_at =
                      ${updatedAt}
                  WHERE id = ${id}
                    AND user_id = ${userId}
                  RETURNING
                    id,
                    user_id,
                    title,
                    completed,
                    created_at,
                    updated_at
                `) as TodoRow[]
        )
      )

      return Result.ok(rows[0] ? toTodo(rows[0]) : null)
    })
  }

  delete(userId: string, id: string) {
    return Effect.gen(async function* () {
      const database = yield* Database

      const rows = yield* Result.await(
        database.run(
          'todo.delete',
          async (sql) =>
            (await sql`
                  DELETE FROM todos
                  WHERE id = ${id}
                    AND user_id = ${userId}
                  RETURNING id
                `) as Array<{
              id: string
            }>
        )
      )

      return Result.ok(rows.length > 0)
    })
  }
}
