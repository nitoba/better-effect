# better-effect-http: matriz de conformidade integrada

Esta matriz pertence à issue [#252](https://github.com/nitoba/better-effect/issues/252).
Ela valida a composição das features já entregues, sem substituir os testes
locais de retry, auth, limits, schema ou streaming.

## Execução reproduzível

Na raiz do monorepo:

```bash
bun install --frozen-lockfile
bun run build --filter=better-effect-http...
bun run --cwd packages/better-effect-http check
```

Os probes focados podem ser executados diretamente no pacote:

```bash
cd packages/better-effect-http
bun test tests/conformance/integrated.test.ts
bun test tests/security.test.ts
bun run test:types
bun run test:package-consumer
```

A matriz usa Bun `1.4.2` e TypeScript `7.0.2` no workspace. O consumer genérico
instala somente `better-effect`, `better-effect-schema`, `better-result` e o
artifact HTTP; o consumer opcional separado instala os providers e Hono. O
smoke de Node é executado quando o Node LTS está disponível no ambiente.

## Cobertura

| Fronteira         | Cenários                                                                                                            | Probe                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Policies + auth   | 503 com retry, 401 com refresh single-flight, credential por envio e teto físico sem reset                          | `integrated.test.ts`, `auth.test.ts`, `schema.test.ts` |
| Observer          | Falha depois de resposta bem-sucedida sem replay ou alteração do resultado                                          | `integrated.test.ts`                                   |
| Lifetime + limits | Permit mantido por stream byte/NDJSON aberto e liberado no fechamento do consumidor; body não consumido é cancelado | `integrated.test.ts`, `stream-session.test.ts`         |
| Segurança         | Corpo cíclico/BigInt/Proxy, headers CRLF e causas cíclicas retornam erro tipado serializável sem payload            | `security.test.ts`                                     |
| Tipos             | Client nomeado, Layer, interceptors/middleware E/R, status/event maps, codecs e terminais                           | `tests/types/`                                         |
| Artifacts         | `.d.ts` publicado, entrypoint genérico sem providers opcionais e smoke Hono/provider separado                       | `tests/package/`                                       |

Falhas de infraestrutura, como ausência do executável `node`, são reportadas
como skip pelo consumer e não convertidas em sucesso silencioso.
