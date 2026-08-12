import { Result } from 'better-result'

import { Effect, Service } from '../better-effect'
import type { CreateTodoInput, UpdateTodoInput } from '../domain'
import { TodoNotFound } from '../errors'
import { TodoRepository } from '../repositories/todo-repository'

export class TodoService extends Service<TodoService>()('TodoService') {
  list(userId: string) {
    return Effect.gen(async function* () {
      const todos = yield* TodoRepository

      const result = yield* Result.await(todos.list(userId))

      return Result.ok(result)
    })
  }

  get(userId: string, id: string) {
    return Effect.gen(async function* () {
      const todos = yield* TodoRepository

      const todo = yield* Result.await(todos.findById(userId, id))

      if (!todo) {
        return Result.err(
          new TodoNotFound({
            id,
            message: 'Todo not found'
          })
        )
      }

      return Result.ok(todo)
    })
  }

  create(userId: string, input: CreateTodoInput) {
    return Effect.gen(async function* () {
      const todos = yield* TodoRepository

      const todo = yield* Result.await(todos.create(userId, input))

      return Result.ok(todo)
    })
  }

  update(userId: string, id: string, input: UpdateTodoInput) {
    return Effect.gen(async function* () {
      const todos = yield* TodoRepository

      const todo = yield* Result.await(todos.update(userId, id, input))

      if (!todo) {
        return Result.err(
          new TodoNotFound({
            id,
            message: 'Todo not found'
          })
        )
      }

      return Result.ok(todo)
    })
  }

  delete(userId: string, id: string) {
    return Effect.gen(async function* () {
      const todos = yield* TodoRepository

      const deleted = yield* Result.await(todos.delete(userId, id))

      if (!deleted) {
        return Result.err(
          new TodoNotFound({
            id,
            message: 'Todo not found'
          })
        )
      }

      return Result.ok()
    })
  }
}
