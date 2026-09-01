# Type-system performance

This benchmark puts an explicit budget around the Layer, Runtime, Hono, and
MQ registry, producer, and Worker inference used by the workspace. It generates
isolated TypeScript fixtures for 10, 25, 50, and 100 Services, Hono middleware
tuples of 1, 3, 6, and 10 validators, 10, 50, 100, and 250 versioned Job
definitions, and producer and Worker handler tuples of 10, 50, and 100 entries,
then runs the project compiler with `--extendedDiagnostics`. The Better Auth fixture additionally
builds and packs `better-effect` and `better-effect-better-auth`, installs those
archives with public Better Auth and better-result peers in an external staging
project, and compiles only against the staged package declarations.

Run the complete matrix with:

```bash
bun run perf:type-system
```

The generated sources live under `benchmarks/type-system/generated/` and are
ignored by Git. Use `--json` for machine-readable output, or narrow a run with
`--sizes=50,100` and `--scenarios=merge,override,program-collections`.
Producer fixtures can be selected with `--producer-sizes=10,50,100 --scenarios=job-producer`;
Worker fixtures can be selected with `--worker-sizes=10,50,100 --scenarios=worker-handlers`.

The Hono fixtures exercise both `http.gen` and `http.handler` with mixed
`param`, `header`, `query`, `cookie`, `json`, and `form` validator inputs. The
middleware tuple grows to ten entries to guard against a fixed-overload
regression.

Each fixture measures:

- `Layer.merge` over all providers;
- `Layer.override` over all providers;
- `Runtime.make` environment inference;
- `Runtime.run` requirement validation;
- transitively required Services (`ServiceN` requires `ServiceN-1`);
- Services exposing five Effect-returning methods each;
- lazy, metadata-aware `Program.named` transformation, observation,
  continuation, and recovery chains;
- lazy `Program.all`, `Program.forEach`, and `Program.allResults` collections,
  including collection names;
- `JobRegistry.make` over exact versioned definition tuples, union extraction,
  and known/unknown identity lookup;
- typed Job producer pipelines over many definitions, including exact Result
  error and Service-requirement inference;
- `Worker.start`/`Worker.use` over immutable handler tuples, including payload,
  JobContext, store, Runtime, and union requirement inference.

The Better Auth, producer, and Worker fixtures run with the current TypeScript
`6.0.3` and minimum supported TypeScript `5.7.2`. Better Auth's exact custom
plugin endpoint, plugin fields, and error-code assertions reject `any` and
`unknown`; the producer fixture locks exact JobId, handler-failure, store,
decode, timeout, and cancellation error metadata; the Worker fixture locks the
exact WorkerRequirements service union and checks both Worker entrypoints. The
report includes compiler, files, types, instantiations, memory, check time, and
total time. Use `--hono-sizes=1,3,6,10` to narrow the Hono matrix, or
`--job-sizes=10,50,100,250 --scenarios=job-registry` to measure only the registry
fixtures. Use `--producer-sizes=10,50,100 --scenarios=job-producer` for the
producer matrix, or `--worker-sizes=10,50,100 --scenarios=worker-handlers` for
the Worker matrix. Use `--clean-dist` to remove generated, core, and MQ
artifacts before dependency preparation. `--check-budget` enforces the current
ceilings:

| Services | Check time |   Types | Instantiations |  Memory |
| -------: | ---------: | ------: | -------------: | ------: |
|       10 |        2 s | 100,000 |        250,000 | 512 MiB |
|       25 |        3 s | 200,000 |        250,000 | 512 MiB |
|       50 |        6 s | 400,000 |        750,000 | 768 MiB |
|      100 |       12 s | 800,000 |      2,000,000 |   1 GiB |

Hono middleware budgets use the same ceilings at the corresponding tuple sizes
(1, 3, 6, and 10), with 400,000 to 600,000 instantiation ceilings to account
for Hono's baseline type graph across the supported TypeScript versions.

The all-at-once `Layer.override` fixtures compile at 50 and 100 Services. The
override validator now carries the current provided union and reuses a base
tag map for exact replacements, avoiding repeated full provenance expansion.
This keeps the full matrix within the configured budgets before adding cycle or
graph validation. TypeScript 6.0.3 currently reports 221,737 instantiations
for the 10-Service program chain and 204,031 for program collections, so the
10-Service ceiling is 250,000 with room for normal compiler variance. The MQ
fixture similarly checks exact tuple/union preservation
and known/unknown identity lookups without recursively validating the tuple,
keeping large registries inside an explicit budget.

Producer ceilings are intentionally generous guardrails rather than CI latency SLAs:

| Producers | Check time |     Types | Instantiations |  Memory |
| --------: | ---------: | --------: | -------------: | ------: |
|        10 |        4 s |   200,000 |        400,000 | 768 MiB |
|        50 |       10 s |   600,000 |      1,500,000 |   1 GiB |
|       100 |       20 s | 1,200,000 |      4,000,000 | 1.5 GiB |

Worker ceilings are intentionally generous guardrails rather than CI latency SLAs:

| Handlers | Check time |     Types | Instantiations |  Memory |
| -------: | ---------: | --------: | -------------: | ------: |
|       10 |        4 s |   200,000 |        500,000 | 768 MiB |
|       50 |       15 s |   700,000 |      3,000,000 |   1 GiB |
|      100 |       45 s | 1,500,000 |     10,000,000 | 1.5 GiB |

Registry ceilings are intentionally generous guardrails rather than CI latency SLAs:

| Jobs | Check time |     Types | Instantiations |  Memory |
| ---: | ---------: | --------: | -------------: | ------: |
|   10 |        2 s |   100,000 |        250,000 | 512 MiB |
|   50 |        6 s |   400,000 |        750,000 | 768 MiB |
|  100 |       12 s |   800,000 |      2,000,000 |   1 GiB |
|  250 |       30 s | 1,500,000 |      6,000,000 | 1.5 GiB |
