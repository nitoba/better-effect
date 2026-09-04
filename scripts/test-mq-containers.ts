import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { MongoDBContainer } from '@testcontainers/mongodb'
import { MySqlContainer } from '@testcontainers/mysql'

const podmanSocket = '/run/user/1000/podman/podman.sock'
const dockerHost = `unix://${podmanSocket}`

const redact = (value: unknown): string =>
  String(value).replace(/\/\/[^/\s:@]+:[^@\s/]+@/gu, '//***:***@')

const requirePodman = (): boolean => {
  if (!existsSync(podmanSocket)) {
    throw new Error(
      `Podman is unavailable: expected the rootless socket at ${podmanSocket}. Start it with ` +
        '`systemctl --user start podman.socket`, then run `bun run test:containers` again.'
    )
  }

  try {
    const info = Bun.spawnSync({
      cmd: ['podman', 'info', '--format', '{{.Host.Security.Rootless}}'],
      env: { ...process.env, DOCKER_HOST: dockerHost },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    if (info.exitCode !== 0) {
      throw new Error(redact(new TextDecoder().decode(info.stderr).trim()))
    }
    return new TextDecoder().decode(info.stdout).trim() === 'true'
  } catch (cause) {
    throw new Error(
      `Podman is unavailable through ${dockerHost}. Verify the rootless service with ` +
        '`systemctl --user status podman.socket` and retry. ' +
        `Diagnostic: ${redact(cause instanceof Error ? cause.message : cause)}`
    )
  }
}

const rootless = requirePodman()
process.env.DOCKER_HOST = dockerHost
if (rootless) process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'

const password = randomBytes(24).toString('hex')
const containers: Array<{ stop(): Promise<void> }> = []
let child: ReturnType<typeof Bun.spawn> | undefined
let interrupted = false

const stopContainers = async (): Promise<void> => {
  const failures: unknown[] = []
  for (const container of [...containers].reverse()) {
    try {
      await container.stop()
    } catch (cause) {
      failures.push(cause)
    }
  }
  if (failures.length > 0) {
    console.error(
      `Container cleanup failed: ${failures
        .map((cause) => redact(cause instanceof Error ? cause.message : cause))
        .join('; ')}`
    )
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    interrupted = true
    child?.kill(signal)
  })
}

try {
  const mysql = await new MySqlContainer('mysql:8.0')
    .withDatabase('better_effect_mq')
    .withRootPassword(password)
    .start()
  containers.push(mysql)
  const mongodb = await new MongoDBContainer('docker.io/library/mongo:8.2').start()
  containers.push(mongodb)

  if (interrupted) {
    process.exitCode = 130
  } else {
    child = Bun.spawn({
      cmd: [
        process.execPath,
        'x',
        'turbo',
        'run',
        'test',
        '--filter=better-effect-mq-mysql',
        '--filter=better-effect-mq-mongodb'
      ],
      cwd: process.cwd(),
      env: {
        ...process.env,
        MYSQL_URL: mysql.getConnectionUri(true),
        MONGODB_URL: mongodb.getConnectionString()
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit'
    })
    const exitCode = await child.exited
    if (exitCode !== 0) process.exitCode = exitCode
  }
} catch (cause) {
  process.exitCode = 1
  console.error(
    `The MQ container conformance gate could not start. It requires Podman at ${dockerHost}. ` +
      `Diagnostic: ${redact(cause instanceof Error ? cause.message : cause)}`
  )
} finally {
  await stopContainers()
  if (interrupted && process.exitCode === undefined) process.exitCode = 130
}
