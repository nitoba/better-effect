import { Err, Result } from 'better-result'

import { Effect, Scope, ServiceRuntime, type Runtime, type ScopeOutcome } from './better-effect'
import {
  readJson,
  requireUser,
  isCreateTodoInput,
  isLoginInput,
  isUpdateTodoInput,
  toEmptyResponse,
  toResponse
} from './http'
import { AuthService } from './services/auth-service'
import { TodoService } from './services/todo-service'
import type { AppLive } from './layers/app-live'

type AppRuntime = Runtime.For<typeof AppLive>

type AppResolver = ReturnType<typeof ServiceRuntime.current>

const runInRequestScope = async <A>(
  resolver: AppResolver,
  parentScope: Scope,
  program: () => A | PromiseLike<A>
): Promise<Awaited<A>> => {
  const requestScope = parentScope.fork()
  let value!: Awaited<A>
  let programFailed = false
  let programFailure: unknown
  let outcome: ScopeOutcome = { status: 'failure', cause: undefined }
  let outcomeStatus: ScopeOutcome['status'] = 'failure'

  try {
    value = await Scope.provide(requestScope, () => ServiceRuntime.run(resolver, program))
    outcome =
      value instanceof Err ? { status: 'failure', cause: value.error } : { status: 'success' }
    outcomeStatus = outcome.status
  } catch (cause) {
    programFailed = true
    programFailure = cause
    outcome = { status: 'failure', cause }
  }

  let cleanupFailure: unknown

  try {
    await requestScope.close(outcome)
  } catch (cause) {
    cleanupFailure = cause
  }

  if (programFailed) {
    throw programFailure
  }

  if (outcomeStatus === 'failure') {
    return value
  }

  if (cleanupFailure !== undefined) {
    throw cleanupFailure
  }

  return value
}

export const createServer = (resolver: AppResolver, parentScope: Scope) => {
  const runtime: Pick<AppRuntime, 'run'> = {
    run: (program) => runInRequestScope(resolver, parentScope, program)
  }

  return Bun.serve({
    port: Number(process.env.PORT ?? 3333),

    routes: {
      '/health': () =>
        Response.json({
          status: 'ok'
        }),

      '/auth/login': {
        POST: async (request) => {
          const result = await runtime.run(
            Effect.fn(async function* () {
              const input = yield* Result.await(readJson(request, isLoginInput))

              const auth = yield* AuthService

              const session = yield* Result.await(auth.login(input))

              return Result.ok(session)
            })
          )

          return toResponse(result)
        }
      },

      '/todos': {
        GET: async (request) => {
          const result = await runtime.run(
            Effect.fn(async function* () {
              const { userId } = yield* Result.await(requireUser(request))

              const todos = yield* TodoService

              const items = yield* Result.await(todos.list(userId))

              return Result.ok(items)
            })
          )

          return toResponse(result)
        },

        POST: async (request) => {
          const result = await runtime.run(
            Effect.fn(async function* () {
              const { userId } = yield* Result.await(requireUser(request))

              const input = yield* Result.await(readJson(request, isCreateTodoInput))

              const todos = yield* TodoService

              const todo = yield* Result.await(
                todos.create(userId, {
                  title: input.title.trim()
                })
              )

              return Result.ok(todo)
            })
          )

          return toResponse(result, 201)
        }
      },

      '/todos/:id': {
        GET: async (request) => {
          const result = await runtime.run(
            Effect.fn(async function* () {
              const { userId } = yield* Result.await(requireUser(request))

              const todos = yield* TodoService

              const todo = yield* Result.await(todos.get(userId, request.params.id))

              return Result.ok(todo)
            })
          )

          return toResponse(result)
        },

        PATCH: async (request) => {
          const result = await runtime.run(
            Effect.fn(async function* () {
              const { userId } = yield* Result.await(requireUser(request))

              const input = yield* Result.await(readJson(request, isUpdateTodoInput))

              const todos = yield* TodoService

              const normalizedInput =
                input.title === undefined ? input : { ...input, title: input.title.trim() }

              const todo = yield* Result.await(
                todos.update(userId, request.params.id, normalizedInput)
              )

              return Result.ok(todo)
            })
          )

          return toResponse(result)
        },

        DELETE: async (request) => {
          const result = await runtime.run(
            Effect.fn(async function* () {
              const { userId } = yield* Result.await(requireUser(request))

              const todos = yield* TodoService

              yield* Result.await(todos.delete(userId, request.params.id))

              return Result.ok()
            })
          )

          return toEmptyResponse(result)
        }
      },

      '/api/*': Response.json(
        {
          error: {
            code: 'NotFound',
            message: 'Route not found'
          }
        },
        {
          status: 404
        }
      )
    },

    error(error) {
      console.error(error)

      return Response.json(
        {
          error: {
            code: 'InternalServerError',
            message: 'Internal server error'
          }
        },
        {
          status: 500
        }
      )
    }
  })
}
