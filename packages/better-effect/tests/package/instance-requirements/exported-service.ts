import { Service } from 'better-effect'

export class Database extends Service<Database>()('Database') {
  query(): string {
    return 'ok'
  }
}

export class Logger extends Service<Logger>()('Logger') {
  log(): void {}
}
