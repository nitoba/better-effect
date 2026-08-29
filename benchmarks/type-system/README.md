# Type-system performance

This benchmark puts an explicit budget around the Layer, Runtime, and Hono
inference already used by `better-effect`. It generates isolated TypeScript
fixtures for 10, 25, 50, and 100 Services, plus Hono middleware tuples of 1, 3,
6, and 10 validators, then runs the project compiler with
`--extendedDiagnostics`.

Run the complete matrix with:

```bash
bun run perf:type-system
```

The generated sources live under `benchmarks/type-system/generated/` and are
ignored by Git. Use `--json` for machine-readable output, or narrow a run with
`--sizes=50,100` and `--scenarios=merge,override,program-collections`.

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
  including collection names.

The report includes files, types, instantiations, memory, check time, and total
time. Use `--hono-sizes=1,3,6,10` to narrow the Hono matrix, or
`--scenarios=hono-mixed` to run only those fixtures. `--check-budget` enforces
the current ceilings:

| Services | Check time |   Types | Instantiations |  Memory |
| -------: | ---------: | ------: | -------------: | ------: |
|       10 |        2 s | 100,000 |        200,000 | 512 MiB |
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
graph validation.
