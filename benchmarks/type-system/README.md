# Type-system performance

This benchmark puts an explicit budget around the Layer and Runtime inference
already used by `better-effect`. It generates isolated TypeScript fixtures for
10, 25, 50, and 100 Services, then runs the project compiler with
`--extendedDiagnostics`.

Run the complete matrix with:

```bash
bun run perf:type-system
```

The generated sources live under `benchmarks/type-system/generated/` and are
ignored by Git. Use `--json` for machine-readable output, or narrow a run with
`--sizes=50,100` and `--scenarios=merge,override`.

Each fixture measures:

- `Layer.merge` over all providers;
- `Layer.override` over all providers;
- `Runtime.make` environment inference;
- `Runtime.run` requirement validation;
- transitively required Services (`ServiceN` requires `ServiceN-1`);
- Services exposing five Effect-returning methods each;
- lazy Program transformation, observation, continuation, and recovery chains.

The report includes files, types, instantiations, memory, check time, and total
time. `--check-budget` enforces the current ceilings:

| Services | Check time |   Types | Instantiations |  Memory |
| -------: | ---------: | ------: | -------------: | ------: |
|       10 |        2 s | 100,000 |        200,000 | 512 MiB |
|       25 |        3 s | 200,000 |        250,000 | 512 MiB |
|       50 |        6 s | 400,000 |        750,000 | 768 MiB |
|      100 |       12 s | 800,000 |      2,000,000 |   1 GiB |

The all-at-once `Layer.override` fixtures compile at 50 and 100 Services. The
override validator now carries the current provided union and reuses a base
tag map for exact replacements, avoiding repeated full provenance expansion.
This keeps the full matrix within the configured budgets before adding cycle or
graph validation.
