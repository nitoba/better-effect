// oxlint-disable anti-slop/no-unknown-parameters -- runtime and cleanup diagnostics accept arbitrary thrown values.
// oxlint-disable anti-slop/no-runtime-typeof -- process.getuid is an optional cross-platform capability.
// oxlint-disable anti-slop/no-conditional-empty-object-spread -- DOCKER_HOST must remain absent when the runtime did not resolve one.
// oxlint-disable typescript/no-redundant-type-constituents -- Bun.spawn's declaration is any in the root script context.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { GenericContainer, type StartedGenericContainer } from 'testcontainers'
import { MySqlContainer } from '@testcontainers/mysql'
import { MongoClient } from 'mongodb'
import {
  bindPortsToLoopback,
  ContainerLifecycle,
  hasOnlyLoopbackBindings
} from './mq-container-support'

const mysqlImage =
  'docker.io/library/mysql:8.0@sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b'
const mongoImage =
  'docker.io/library/mongo:8.2.5@sha256:36c721afe62f338e3bf201b0e24f209f0fa4bf9a50ab43e69a91d4e7e2c10816'
const labelName = 'better-effect-mq.container-gate'
const invocation = randomUUID()
const labels = { [labelName]: invocation }
const storageIntegrationTests = [
  'packages/better-effect-mq-mysql/tests/integration.mysql.test.ts',
  'packages/better-effect-mq-mongodb/tests/integration/mongodb.test.ts'
] as const
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

class LoopbackMySqlContainer extends MySqlContainer {
  constructor(image: string) {
    super(image)
    bindPortsToLoopback(this.hostConfig.PortBindings)
  }
}

class PinnedMongoReplicaSetContainer extends GenericContainer {
  #username: string | undefined
  #password: string | undefined

  constructor(image: string) {
    super(image)
    this.withExposedPorts(27017).withStartupTimeout(120_000)
    bindPortsToLoopback(this.hostConfig.PortBindings)
  }

  withUsername(username: string): this {
    this.#username = username
    return this
  }

  withPassword(password: string): this {
    this.#password = password
    return this
  }

  async start(): Promise<StartedGenericContainer> {
    if (this.#username === undefined || this.#password === undefined)
      throw new Error('MongoDB root credentials are required')
    this.withEnvironment({
      MONGO_INITDB_ROOT_USERNAME: this.#username,
      MONGO_INITDB_ROOT_PASSWORD: this.#password
    })
      .withCopyContentToContainer([
        { content: '1111111111', mode: 0o400, target: '/data/db/key.txt' }
      ])
      .withCommand(['--replSet', 'rs0', '--keyFile', '/data/db/key.txt'])
      .withHealthCheck({
        test: [
          'CMD-SHELL',
          `mongosh -u ${this.#username} -p ${this.#password} --quiet --eval 'try { rs.status(); } catch (e) { rs.initiate(); } while (db.runCommand({isMaster: 1}).ismaster==false) { sleep(100); }'`
        ],
        interval: 5000,
        timeout: 60_000,
        retries: 1000
      })
    return super.start()
  }
}

let child: ReturnType<typeof Bun.spawn> | undefined
let interrupted = false
let signals = 0

const runStorageIntegrationTests = async (
  mysqlUrl: string,
  mongoDatabase: string,
  mongoUrl: string
): Promise<number> => {
  child = Bun.spawn({
    cmd: [process.execPath, 'test', ...storageIntegrationTests],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MYSQL_URL: mysqlUrl,
      MONGODB_DATABASE: mongoDatabase,
      MONGODB_URL: mongoUrl
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit'
  })

  const childProcess = child
  let reportedFailures: number | undefined
  const stdout = childProcess.stdout
  const forwardOutput = async (): Promise<void> => {
    if (stdout === null) return
    const decoder = new TextDecoder()
    let tail = ''
    for await (const chunk of stdout) {
      const text = decoder.decode(chunk, { stream: true })
      process.stdout.write(text)
      tail = `${tail}${text}`.slice(-4096)
      const summary = tail.match(/(?:^|\n)\s*(\d+)\s+fail\b/u)
      if (summary !== null && reportedFailures === undefined) {
        reportedFailures = Number(summary[1])
        childProcess.kill('SIGKILL')
      }
    }
    process.stdout.write(decoder.decode())
  }

  const outputComplete = forwardOutput()
  const childExitCode = await childProcess.exited
  await outputComplete
  if (reportedFailures !== undefined) return reportedFailures === 0 ? 0 : 1
  return childExitCode
}

const fallbackCleanup = async (): Promise<readonly unknown[]> => {
  if (runtime.command === undefined) return []
  const environment = {
    ...process.env,
    ...(runtime.dockerHost === undefined ? {} : { DOCKER_HOST: runtime.dockerHost })
  }
  const listed = command(
    [runtime.command, 'ps', '--all', '--quiet', '--filter', `label=${labelName}=${invocation}`],
    environment
  )
  if (listed.exitCode !== 0)
    return [new Error(`could not list scoped containers: ${redact(failure(listed))}`)]
  const ids = output(listed).split(/\s+/u).filter(Boolean)
  if (ids.length === 0) return []
  const removed = command([runtime.command, 'rm', '--force', ...ids], environment)
  return removed.exitCode === 0
    ? []
    : [new Error(`could not remove scoped containers: ${redact(failure(removed))}`)]
}

const lifecycle = new ContainerLifecycle(fallbackCleanup)

const assertLoopbackBindings = (container: { readonly getId: () => string }): void => {
  if (runtime.command === undefined)
    throw new Error('no container runtime was available for port inspection')
  const inspected = command([
    runtime.command,
    'inspect',
    container.getId(),
    '--format',
    '{{json .HostConfig.PortBindings}}'
  ])
  if (inspected.exitCode !== 0)
    throw new Error(`could not inspect database port bindings: ${redact(failure(inspected))}`)
  let bindings: unknown
  try {
    bindings = JSON.parse(output(inspected))
  } catch (cause) {
    throw new Error(
      `database port binding inspection returned invalid JSON: ${redact(cause instanceof Error ? cause.message : cause)}`
    )
  }
  if (!hasOnlyLoopbackBindings(bindings))
    throw new Error('database ports must bind only to 127.0.0.1, never 0.0.0.0 or ::')
}

const onSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
  interrupted = true
  signals += 1
  child?.kill(signals === 1 ? signal : 'SIGKILL')
  void lifecycle.cleanup()
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
  const mysql = await lifecycle.start(() =>
    new LoopbackMySqlContainer(mysqlImage)
      .withLabels(labels)
      .withDatabase('better_effect_mq')
      .withUsername(mysqlUsername)
      .withUserPassword(secret())
      .withRootPassword(secret())
      .start()
  )
  assertLoopbackBindings(mysql)
  if (interrupted) throw new Error('container gate interrupted during MySQL startup')

  const mongoRootUsername = `root_${secret(8)}`
  const mongoRootPassword = secret()
  const mongoDatabase = `better_effect_mq_mongodb_${process.pid}`
  const mongoUsername = `mq_${secret(8)}`
  const mongoPassword = secret()
  const mongodb = await lifecycle.start(() =>
    new PinnedMongoReplicaSetContainer(mongoImage)
      .withLabels(labels)
      .withUsername(mongoRootUsername)
      .withPassword(mongoRootPassword)
      .start()
  )
  assertLoopbackBindings(mongodb)
  if (interrupted) throw new Error('container gate interrupted during MongoDB startup')

  const mongoRootUrl = new URL(
    `mongodb://${mongoRootUsername}:${mongoRootPassword}@${mongodb.getHost()}:${mongodb.getMappedPort(27017)}/admin`
  )
  mongoRootUrl.searchParams.set('authSource', 'admin')
  mongoRootUrl.searchParams.set('directConnection', 'true')
  const administrator = new MongoClient(mongoRootUrl.toString(), { directConnection: true })
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
  const mongoUrl = new URL(mongoRootUrl)
  mongoUrl.username = mongoUsername
  mongoUrl.password = mongoPassword
  mongoUrl.pathname = `/${mongoDatabase}`
  mongoUrl.searchParams.set('authSource', mongoDatabase)
  mongoUrl.searchParams.set('directConnection', 'true')

  const childExitCode = await runStorageIntegrationTests(
    mysql.getConnectionUri(),
    mongoDatabase,
    mongoUrl.toString()
  )
  if (childExitCode !== 0) exitCode = childExitCode
} catch (cause) {
  exitCode = interrupted ? 130 : 1
  console.error(`The MQ container conformance gate could not complete. ${runtimeDiagnostic()}`)
  console.error(`Diagnostic: ${redact(cause instanceof Error ? cause.message : cause)}`)
} finally {
  const cleanupFailures = await lifecycle.cleanup()
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
