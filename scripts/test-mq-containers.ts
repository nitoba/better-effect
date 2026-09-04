// oxlint-disable anti-slop/no-unknown-parameters -- runtime and cleanup diagnostics accept arbitrary thrown values.
// oxlint-disable anti-slop/no-runtime-typeof -- process.getuid is an optional cross-platform capability.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- DOCKER_HOST must remain absent when the runtime did not resolve one.
// oxlint-disable typescript/no-redundant-type-constituents -- Bun.spawn's declaration is any in the root script context.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { MongoDBContainer } from '@testcontainers/mongodb'
import { MySqlContainer } from '@testcontainers/mysql'
import { MongoClient } from 'mongodb'

const mysqlImage =
  'docker.io/library/mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b'
const mongoImage = 'docker.io/library/mongo:8.2.5'
const labelName = 'better-effect-mq.container-gate'
const invocation = randomUUID()
const labels = { [labelName]: invocation }
const decoder = new TextDecoder()
const secrets = new Set<string>()

const secret = (bytes = 24): string => {
  const value = randomBytes(bytes).toString('base64url')
  secrets.add(value)
  return value
}
const redact = (value: unknown): string => {
  let text = String(value).replace(/\/\/[^/\s:@]+:[^@\s/]+@/gu, '//***:***@')
  for (const value of secrets) text = text.replaceAll(value, '***')
  return text
}
const command = (cmd: readonly string[], env = process.env) =>
  Bun.spawnSync({ cmd: [...cmd], env, stdout: 'pipe', stderr: 'pipe' })
const output = (result: ReturnType<typeof command>): string => decoder.decode(result.stdout).trim()
const failure = (result: ReturnType<typeof command>): string => decoder.decode(result.stderr).trim()

interface ContainerRuntime {
  readonly command: 'podman' | 'docker' | undefined
  readonly rootless: boolean
  readonly dockerHost: string | undefined
}

const socketDockerHost = (path: string): string => `unix://${path}`
const resolveContainerRuntime = (): ContainerRuntime => {
  const inherited = process.env.DOCKER_HOST
  let discoveredPodman = false
  if (inherited === undefined) {
    const candidates = [
      ...(process.env.XDG_RUNTIME_DIR === undefined
        ? []
        : [`${process.env.XDG_RUNTIME_DIR}/podman/podman.sock`]),
      ...(typeof process.getuid !== 'function'
        ? []
        : [`/run/user/${process.getuid()}/podman/podman.sock`])
    ]
    const socket = candidates.find(existsSync)
    if (socket !== undefined) {
      process.env.DOCKER_HOST = socketDockerHost(socket)
      discoveredPodman = true
    } else {
      const remoteSocket = command(['podman', 'info', '--format', '{{.Host.RemoteSocket.Path}}'])
      const path = output(remoteSocket)
      if (remoteSocket.exitCode === 0 && path.length > 0) {
        process.env.DOCKER_HOST = socketDockerHost(path)
        discoveredPodman = true
      }
    }
  }

  if (discoveredPodman || inherited?.includes('podman') === true) {
    const podman = command(
      ['podman', 'info', '--format', '{{.Host.Security.Rootless}}'],
      process.env
    )
    if (podman.exitCode === 0)
      return {
        command: 'podman',
        rootless: output(podman) === 'true',
        dockerHost: process.env.DOCKER_HOST
      }
  }

  const docker = command(['docker', 'info', '--format', '{{.ServerVersion}}'], process.env)
  return {
    command: docker.exitCode === 0 ? 'docker' : undefined,
    rootless: false,
    dockerHost: process.env.DOCKER_HOST
  }
}

const runtime = resolveContainerRuntime()
if (runtime.rootless) process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'

type ManagedContainer = { readonly getId: () => string; readonly stop: () => Promise<void> }
const containers: ManagedContainer[] = []
let child: ReturnType<typeof Bun.spawn> | undefined
let interrupted = false
let signals = 0
let cleanupPromise: Promise<readonly unknown[]> | undefined
const cleanupFailures: unknown[] = []

const fallbackCleanup = async (): Promise<readonly unknown[]> => {
  if (runtime.command !== 'podman') return []
  const environment = {
    ...process.env,
    ...(runtime.dockerHost === undefined ? {} : { DOCKER_HOST: runtime.dockerHost })
  }
  const listed = command(
    ['podman', 'ps', '--all', '--quiet', '--filter', `label=${labelName}=${invocation}`],
    environment
  )
  if (listed.exitCode !== 0)
    return [new Error(`could not list scoped Podman containers: ${redact(failure(listed))}`)]
  const ids = output(listed).split(/\s+/u).filter(Boolean)
  if (ids.length === 0) return []
  const removed = command(['podman', 'rm', '--force', ...ids], environment)
  return removed.exitCode === 0
    ? []
    : [new Error(`could not remove scoped Podman containers: ${redact(failure(removed))}`)]
}

const cleanup = async (): Promise<readonly unknown[]> => {
  if (cleanupPromise !== undefined) return cleanupPromise
  const current = (async () => {
    const failures: unknown[] = []
    for (let index = containers.length - 1; index >= 0; index -= 1) {
      const container = containers[index]!
      try {
        await container.stop()
        containers.splice(index, 1)
      } catch (cause) {
        failures.push(cause)
      }
    }
    failures.push(...(await fallbackCleanup()))
    cleanupFailures.push(...failures)
    return failures
  })()
  cleanupPromise = current
  try {
    return await current
  } finally {
    if (cleanupPromise === current) cleanupPromise = undefined
  }
}

const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
  interrupted = true
  signals += 1
  child?.kill(signals === 1 ? signal : 'SIGKILL')
  void cleanup()
}
process.on('SIGINT', onSignal)
process.on('SIGTERM', onSignal)

const runtimeDiagnostic = (): string =>
  runtime.dockerHost === undefined
    ? 'No DOCKER_HOST was configured and no rootless Podman socket was found. Start Docker, or start Podman with `systemctl --user start podman.socket` and set DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock.'
    : `Container runtime at ${runtime.dockerHost} was unavailable. Verify its daemon/socket and retry.`

let exitCode = 0
try {
  const mysqlUsername = `mq_${secret(8)}`
  const mysql = await new MySqlContainer(mysqlImage)
    .withLabels(labels)
    .withDatabase('better_effect_mq')
    .withUsername(mysqlUsername)
    .withUserPassword(secret())
    .withRootPassword(secret())
    // Testcontainers 12 accepts container/host ports but no bind address; its
    // modules allocate random host ports, so this gate never requests a fixed port.
    .start()
  containers.push(mysql)
  if (interrupted) throw new Error('container gate interrupted during MySQL startup')

  const mongoRootUsername = `root_${secret(8)}`
  const mongoRootPassword = secret()
  const mongoDatabase = `better_effect_mq_mongodb_${process.pid}`
  const mongoUsername = `mq_${secret(8)}`
  const mongoPassword = secret()
  const mongodb = await new MongoDBContainer(mongoImage)
    .withLabels(labels)
    .withUsername(mongoRootUsername)
    .withPassword(mongoRootPassword)
    .start()
  containers.push(mongodb)
  if (interrupted) throw new Error('container gate interrupted during MongoDB startup')

  const administrator = new MongoClient(mongodb.getConnectionString(), { directConnection: true })
  try {
    await administrator.connect()
    await administrator.db(mongoDatabase).command({
      createUser: mongoUsername,
      pwd: mongoPassword,
      roles: [
        { role: 'readWriteAnyDatabase', db: 'admin' },
        { role: 'dbAdminAnyDatabase', db: 'admin' }
      ]
    })
  } finally {
    await administrator.close()
  }
  const mongoUrl = new URL(mongodb.getConnectionString())
  mongoUrl.username = mongoUsername
  mongoUrl.password = mongoPassword
  mongoUrl.pathname = `/${mongoDatabase}`
  mongoUrl.searchParams.set('authSource', mongoDatabase)
  mongoUrl.searchParams.set('directConnection', 'true')

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
      MYSQL_URL: mysql.getConnectionUri(),
      MONGODB_DATABASE: mongoDatabase,
      MONGODB_URL: mongoUrl.toString()
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  })
  const childExitCode = await child.exited
  if (childExitCode !== 0) exitCode = childExitCode
} catch (cause) {
  exitCode = interrupted ? 130 : 1
  console.error(`The MQ container conformance gate could not complete. ${runtimeDiagnostic()}`)
  console.error(`Diagnostic: ${redact(cause instanceof Error ? cause.message : cause)}`)
} finally {
  await cleanup()
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  if (cleanupFailures.length > 0) {
    console.error(
      `Container cleanup failed: ${cleanupFailures
        .map((cause) => redact(cause instanceof Error ? cause.message : cause))
        .join('; ')}`
    )
    if (exitCode === 0) exitCode = 1
  }
  if (interrupted && exitCode === 0) exitCode = 130
  process.exitCode = exitCode
}
