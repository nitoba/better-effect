import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const failures = []

if (packageJson.name !== "better-effect-schema") {
  failures.push(`Unexpected package name: ${String(packageJson.name)}`)
}

if (packageJson.type !== "module") {
  failures.push("The package must remain ESM-only.")
}

if (packageJson.exports?.["."]?.require !== undefined) {
  failures.push("The ESM-only package must not publish a CommonJS require condition.")
}

for (const dependency of [
  "arktype",
  "better-effect",
  "better-result",
  "typescript",
  "valibot",
  "zod"
]) {
  if (typeof packageJson.peerDependencies?.[dependency] !== "string") {
    failures.push(`Missing peer dependency: ${dependency}`)
  }
}

for (const dependency of ["arktype", "valibot", "zod"]) {
  if (packageJson.peerDependenciesMeta?.[dependency]?.optional !== true) {
    failures.push(`Optional peer dependency metadata is missing: ${dependency}`)
  }
}

if (typeof packageJson.dependencies?.["@standard-schema/spec"] !== "string") {
  failures.push("@standard-schema/spec must be a production dependency.")
}

const sourceFiles = []
const collect = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path)
    if (entry.isFile() && entry.name.endsWith(".ts")) sourceFiles.push(path)
  }
}
await collect(join(root, "src"))

for (const path of sourceFiles) {
  const source = await readFile(path, "utf8")
  if (/from\s+["'](?:effect|@effect\/)/u.test(source)) {
    failures.push(`${path}: must not import Effect TS packages`)
  }
  if (/from\s+["'](?:better-effect|better-result)\//u.test(source)) {
    failures.push(`${path}: must use public better-effect/better-result entrypoints`)
  }
}

for (const declaration of [
  "index.d.ts",
  "schema.d.ts",
  "operations.d.ts",
  "arktype.d.ts",
  "valibot.d.ts",
  "zod.d.ts"
]) {
  const path = join(root, "dist", "esm", declaration)
  const source = await readFile(path, "utf8")
  if (/from\s+["']\.\/internal\//u.test(source)) {
    failures.push(`${path}: public declarations must not expose internal type modules`)
  }

  if (declaration === "index.d.ts" && /(?:zod|ZodClass|safeMake|_zod|Legacy)/u.test(source)) {
    failures.push(`${path}: the root declaration must remain provider-neutral`)
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}

console.log("Package boundary check passed.")
