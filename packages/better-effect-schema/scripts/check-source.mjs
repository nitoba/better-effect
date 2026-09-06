import { readdir, readFile } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const sourceRoot = join(root, "src")

const forbidden = [
  { label: "TypeScript suppression", pattern: /@ts-(?:ignore|nocheck)/u },
  { label: "public or internal any", pattern: /\bany\b/u },
  { label: "legacy parser override", pattern: /\._parse(?:Sync|Async)?\b/u },
  { label: "legacy parser type", pattern: /\b(?:ParseInput|ParseReturnType|SyncParseReturnType)\b/u },
  { label: "direct Zod class construction", pattern: /\bnew\s+Zod(?!ClassError\b)[A-Z]\w*/u },
  { label: "legacy type-fest dependency", pattern: /\btype-fest\b/u },
  { label: "Effect TS dependency", pattern: /from\s+["'](?:effect(?:\/[^"']*)?|@effect\/[^"']*)["']/u },
  { label: "private better ecosystem import", pattern: /from\s+["'](?:better-effect|better-result)\//u }
]

const generatedSourcePattern = /(?:\.d\.(?:cts|mts|ts)|\.(?:cjs|js|mjs))$/u
const typescriptSourcePattern = /(?<!\.d)\.ts$/u

const collect = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    if (entry.isFile()) files.push(path)
  }

  return files
}

const violations = []
for (const path of await collect(sourceRoot)) {
  const filename = basename(path)

  if (generatedSourcePattern.test(filename)) {
    violations.push(
      `${relative(root, path)}: generated JavaScript or declaration artifact inside src`
    )
    continue
  }

  if (!typescriptSourcePattern.test(filename)) continue

  const source = await readFile(path, "utf8")
  const lines = source.split("\n")

  for (const rule of forbidden) {
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) {
        violations.push(
          `${relative(root, path)}:${index + 1}: ${rule.label}: ${line.trim()}`
        )
      }
    })
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"))
  process.exit(1)
}

console.log("Source policy check passed.")
