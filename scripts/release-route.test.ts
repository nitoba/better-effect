import { expect, test } from 'bun:test'

const routeScript = new URL('./release-route.ts', import.meta.url).pathname

const runRoute = (...args: string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, routeScript, ...args],
    stdout: 'pipe',
    stderr: 'pipe'
  })

const readRoute = (...args: string[]) => {
  const result = runRoute(...args)
  expect(result.exitCode).toBe(0)

  return Object.fromEntries(
    result.stdout
      .toString()
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      })
  )
}

test('resolves every qualified package route', () => {
  expect(readRoute('--tag', 'v0.14.0')).toMatchObject({
    package_name: 'better-effect',
    tag_prefix: 'v',
    release_version: '0.14.0',
    initial_release: 'false'
  })
  expect(readRoute('--tag', 'better-effect-better-auth-v0.1.0')).toMatchObject({
    package_name: 'better-effect-better-auth',
    release_version: '0.1.0',
    initial_release: 'true'
  })
  expect(readRoute('--tag', 'better-effect-better-auth-v0.2.0')).toMatchObject({
    package_name: 'better-effect-better-auth',
    release_version: '0.2.0',
    initial_release: 'false'
  })
  expect(readRoute('--tag', 'better-effect-mq-v0.1.0')).toMatchObject({
    package_name: 'better-effect-mq',
    release_version: '0.1.0',
    initial_release: 'true'
  })
  expect(readRoute('--tag', 'better-effect-mq-v0.1.1')).toMatchObject({
    package_name: 'better-effect-mq',
    release_version: '0.1.1',
    initial_release: 'false'
  })
  expect(readRoute('--tag', 'better-effect-kysely-v0.1.0')).toMatchObject({
    package_name: 'better-effect-kysely',
    release_version: '0.1.0',
    initial_release: 'true'
  })
  expect(readRoute('--tag', 'better-effect-kysely-v0.1.1')).toMatchObject({
    package_name: 'better-effect-kysely',
    release_version: '0.1.1',
    initial_release: 'false'
  })
})

test('keeps initial-release metadata for local package selection', () => {
  expect(readRoute('--package', 'better-effect-better-auth').initial_release).toBe('true')
  expect(readRoute('--package', 'better-effect-mq').initial_release).toBe('true')
  expect(readRoute('--package', 'better-effect-kysely').initial_release).toBe('true')
})

test('rejects unallowlisted tags', () => {
  expect(runRoute('--tag', 'better-effect-v0.1.0').exitCode).not.toBe(0)
})
