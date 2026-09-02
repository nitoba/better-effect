import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), "better-effect-zod-consumer-"))

const run = (command, args, cwd, capture = false) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit"
  })

  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stdout ?? "")
      process.stderr.write(result.stderr ?? "")
    }
    throw new Error(`${command} ${args.join(" ")} failed`)
  }

  return result.stdout ?? ""
}

const linkDependency = async (name, consumerModules) => {
  const source = await realpath(join(root, "node_modules", name))
  const destination = join(consumerModules, name)
  await mkdir(dirname(destination), { recursive: true })
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir")
}

try {
  const artifacts = join(temporary, "artifacts")
  const extracted = join(temporary, "extracted")
  const consumer = join(temporary, "consumer")
  const consumerModules = join(consumer, "node_modules")

  await mkdir(artifacts, { recursive: true })
  await mkdir(extracted, { recursive: true })
  await mkdir(consumerModules, { recursive: true })

  run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts], root, true)

  const archives = (await readdir(artifacts)).filter((name) => name.endsWith(".tgz"))
  if (archives.length !== 1) {
    throw new Error(`Expected one package archive, found ${archives.length}`)
  }

  const archive = join(artifacts, archives[0])
  const listing = run("tar", ["-tzf", archive], root, true)
  const forbiddenArchiveEntries = listing
    .split("\n")
    .filter(Boolean)
    .filter((entry) => /(?:^|\/)(?:node_modules|src|tests|type-tests|examples|\.git)(?:\/|$)/u.test(entry))

  if (forbiddenArchiveEntries.length > 0) {
    throw new Error(`Unexpected archive entries:\n${forbiddenArchiveEntries.join("\n")}`)
  }

  run("tar", ["-xzf", archive, "-C", extracted], root)
  await rename(join(extracted, "package"), join(consumerModules, "better-effect-zod"))

  for (const dependency of ["better-effect", "better-result", "zod"]) {
    await linkDependency(dependency, consumerModules)
  }

  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "better-effect-zod-external-consumer",
    private: true,
    type: "module"
  }, null, 2))

  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      outDir: "out"
    },
    include: ["smoke.ts"]
  }, null, 2))

  await writeFile(join(consumer, "smoke.ts"), `import * as z from "zod"
import type { Effect } from "better-effect"
import { Result, TaggedError } from "better-result"
import {
  Schema,
  SchemaDecodeFailure,
  SchemaEncodeFailure
} from "better-effect-zod"

const DateFromISOString = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString()
})

class User extends Schema.Class<User>("external/User")({
  id: z.uuid(),
  createdAt: DateFromISOString
}) {}

const operation = Result.gen(function* () {
  const user = yield* Schema.decodeUnknown(User)({
    id: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: "2026-09-02T10:00:00.000Z"
  })
  const encoded = yield* Schema.encode(User)(user)
  return Result.ok(encoded)
})

operation satisfies Effect<
  Schema.Encoded<typeof User>,
  SchemaDecodeFailure | SchemaEncodeFailure,
  never
>

if (operation.status === "error") throw operation.error
if (operation.value.createdAt !== "2026-09-02T10:00:00.000Z") {
  throw new Error("Archive consumer round-trip failed")
}

class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound",
  { id: z.uuid() }
) {}

const failure = new UserNotFound({
  id: "550e8400-e29b-41d4-a716-446655440000"
})
if (!TaggedError.is(failure)) throw new Error("TaggedError protocol was lost")

console.log("external-consumer: ok")
`)

  run("tsc", ["-p", "tsconfig.json"], consumer)
  run(process.execPath, [join(consumer, "out", "smoke.js")], consumer)

  const packageJson = JSON.parse(
    await readFile(join(consumerModules, "better-effect-zod", "package.json"), "utf8")
  )
  if (packageJson.name !== "better-effect-zod" || packageJson.version !== "0.1.0") {
    throw new Error("Packed package identity is invalid")
  }

  console.log("External tarball consumer check passed.")
} finally {
  await rm(temporary, { recursive: true, force: true })
}
