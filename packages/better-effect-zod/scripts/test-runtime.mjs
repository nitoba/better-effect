import { spawnSync } from "node:child_process"

const result = spawnSync(
  process.execPath,
  ["--test", "tests/runtime/*.test.mjs"],
  { cwd: new URL("../", import.meta.url), stdio: "inherit", shell: true }
)

process.exit(result.status ?? 1)
