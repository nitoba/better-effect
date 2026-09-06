import { spawnSync } from "node:child_process"

const isBun = typeof process.versions.bun === "string"
const args = isBun
  ? ["test", "tests/runtime/*.test.mjs"]
  : ["--test", "tests/runtime/*.test.mjs"]
const result = spawnSync(process.execPath, args, {
  cwd: new URL("../", import.meta.url),
  stdio: "inherit",
  shell: true
})

process.exit(result.status ?? 1)
