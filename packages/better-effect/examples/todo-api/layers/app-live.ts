import { SQL } from 'bun'

import { Layer } from '../better-effect'
import { Database } from '../database'
import { PasswordHasher } from '../password-hasher'
import { SessionRepository } from '../repositories/session-repository'
import { TodoRepository } from '../repositories/todo-repository'
import { UserRepository } from '../repositories/user-repository'
import { AuthService } from '../services/auth-service'
import { TodoService } from '../services/todo-service'

const DatabaseLive = Layer.scopedDisposable(Database, async () => {
  const database = new Database(new SQL(':memory:', { adapter: 'sqlite' }))
  await database.initialize()
  return database
})

const RepositoriesLive = Layer.merge(
  Layer.make(UserRepository),
  Layer.make(SessionRepository),
  Layer.make(TodoRepository)
)

const ServicesLive = Layer.merge(
  Layer.make(PasswordHasher),
  Layer.make(AuthService),
  Layer.make(TodoService)
)

export const AppLive = Layer.merge(DatabaseLive, RepositoriesLive, ServicesLive)
