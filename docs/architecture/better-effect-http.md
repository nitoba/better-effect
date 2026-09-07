# better-effect-http: contratos públicos e fronteiras A/E/R

Status: contrato de arquitetura para a issue #230. Este documento fixa as
decisões que o pacote deverá implementar nas issues seguintes; não adiciona
transporte, runtime HTTP, pacote, export ou integração de servidor nesta issue.

Referências: [#230](https://github.com/nitoba/better-effect/issues/230),
[#229](https://github.com/nitoba/better-effect/issues/229),
[decisão de schema #209](https://github.com/nitoba/better-effect/issues/209) e
[Layer-first #144](https://github.com/nitoba/better-effect/issues/144).

## 1. Escopo e vocabulário

O contrato HTTP é descrito na linguagem já existente no `better-effect`:

- `A` é o valor de sucesso;
- `E` é o erro explícito propagado como `Result.err`;
- `R` é a união de instâncias `Service` exigidas pelo programa;
- `Effect<A, E, R>` continua sendo a fachada de tipos sobre `better-result`, e
  não uma árvore lazy, scheduler, Fiber ou Context;
- `Layer<Provided, Required>` descreve apenas capacidades fornecidas e
  exigências externas do bootstrap;
- `Runtime` executa programas e valida as exigências de execução contra a
  camada disponível.

Esta issue é deliberadamente um contrato e seus type probes. A implementação
do pacote e seus transportes pertencem às issues downstream. Os probes em
`tests/types/design/` são declarações locais de design: não são uma API
publicada e não podem ser importados pelo código de produção.

## 2. Token, camada e operação

O cliente padrão é um token yieldable chamado `HttpClient`. Clientes nomeados
são derivados pelo mesmo factory:

```ts
const PartnerHttp = HttpClient.service('@app/PartnerHttp', {
  interceptors: [authentication],
  retry: retryReads
})

const PartnerHttpLive = PartnerHttp.layer(function* () {
  const config = yield* HttpConfig
  return { baseUrl: config.baseUrl }
})
```

`HttpClient.service(tag, policies?)` retorna o token diretamente. Não há um
objeto `{ Tag, layer }`, argumentos de `Runtime` no factory, nem token global
mutado por uma camada. O tag literal é a identidade lógica estável; a classe
construtora continua sendo token e handle de `Service`.

O factory de `.layer` pode exigir `Service`s durante a construção e preserva
essas exigências como `Layer.Required`. Somente capacidades estáveis e
pertencentes à camada podem ser capturadas durante o bootstrap. As exigências
de cada callback do programa continuam sendo verificadas na fronteira de
execução e não são consideradas satisfeitas só porque uma camada foi criada.

O contrato conceitual mínimo é:

```ts
type HttpOperation<A, E, R extends Service.Any = never> = AsyncGenerator<
  Err<never, E> | ServiceRequirement<R>,
  A,
  unknown
>

type HttpResponse<A, Status extends number = number> = {
  readonly status: Status
  readonly headers: Headers
  readonly url: string
  readonly data: A
}
```

Uma operação é async-yieldable e single-use. Ela não é `Promise`, não é
thenable e não ganha métodos de Promise. `yield*` de um `HttpOperation` deve
preservar todos os canais; `Effect.fn`, `Effect.gen` e `Program.andThen`
devem produzir a união de `A`, `E` e `R` de todos os programas envolvidos.

## 3. Métodos e opções

O cliente oferece os métodos buffered `get`, `post`, `put`, `patch`, `delete`,
`head` e o genérico `request(method, path, options?)`. O corpo fica dentro de
`options`; não existe argumento posicional de body.

| Campo/operação | Contrato                                                                  |
| -------------- | ------------------------------------------------------------------------- |
| `path`         | string relativo ao `baseUrl` configurado                                  |
| `method`       | `GET \| POST \| PUT \| PATCH \| DELETE \| HEAD` em `request`              |
| `body`         | valor a serializar/enviar; sua mutabilidade segue as regras do transporte |
| `headers`      | `HeadersInit`; preparação não muta o objeto recebido                      |
| `query`        | registro readonly de string, number, boolean ou undefined                 |
| `signal`       | `AbortSignal` opcional                                                    |
| `schema`       | um Standard Schema para decodificar o body e inferir `A`                  |
| `responses`    | mapa status → Standard Schema para resposta discriminada                  |

`schema` e `responses` são modos mutuamente exclusivos. Com `schema`, o
sucesso é `HttpResponse<SchemaOutput>`. Com `responses`, o sucesso é a união
de `HttpResponse<SchemaOutput, Status>` para cada chave numérica do mapa.
Uma resposta sem conteúdo é representada explicitamente por
`HttpResponse<undefined, 204>` (ou outro status configurado), nunca por
`void` implícito ou descarte do envelope. Sem decoder, o tipo de dados é
`unknown`.

## 4. Schema e neutralidade de provider

O contrato aceita o protocolo provider-neutral Standard Schema: input e output
são distintos e `validate` pode retornar o resultado de forma síncrona ou
assíncrona. O input do schema é usado por endpoints e opções tipadas; o output
é usado no `data` da resposta. Transformações assíncronas fazem parte do
mesmo contrato e não podem ser tratadas como valor já decodificado.

As operações públicas usam `better-effect-schema` como peer/provider-neutral,
conforme #209. O HTTP não importa adapters de Zod, Valibot, ArkType ou
caminhos de `node_modules`; nenhum tipo ou identificador de provider pode
vazar para `HttpClient`, `HttpOperation`, `HttpStream` ou endpoints. Os probes
usam apenas um espelho estrutural local do protocolo, para testar a fronteira
sem criar dependência privada.

## 5. Canais e erros

O pacote possui uma taxonomia própria de erros explícitos para as fronteiras
que ele controla:

- `HttpTransportError`: falha de rede, transporte ou leitura da resposta;
- `HttpStatusError`: status sem decoder correspondente ou status não aceito;
- `HttpParseError`: body que não pôde ser convertido no formato pedido;
- `HttpSchemaError`: falha de validação/transformação Standard Schema;
- `HttpHookError`: throw ou rejection de interceptor, hook, middleware ou
  predicado durante execução válida;
- `HttpAbortError`: cancelamento/abort do sinal da operação;
- `HttpCleanupError`: falha observada durante cleanup pertencente à operação.

Os tipos acima são o núcleo HTTP; políticas podem acrescentar seus próprios
erros ao `E`. Um `Result.err` de domínio continua sendo `Err` e preserva o
erro original. Em um contexto de execução válido, throw/rejection de
transporte, parser, schema, hook ou predicado é capturado no canal HTTP
apropriado. Falhas de configuração, resolução de `Service`, lifecycle ou
bootstrap continuam sendo defects do runtime e não são convertidas em
`HttpTransportError`.

## 6. Pipeline de uma operação

Cada execução deve seguir uma única ordem conceitual:

1. preparar URL, query, headers e body sem alterar as entradas;
2. executar middleware/interceptors lógicos;
3. entregar controle ao retry controller único;
4. aplicar admissão e limites;
5. executar `onRequest`;
6. chamar o transporte;
7. construir o envelope de response;
8. classificar status e decodificar body;
9. decidir retry ou terminação;
10. executar schema final;
11. emitir observação/eventos e concluir a operação.

Não pode haver duas autoridades de retry (por exemplo, uma no middleware e
outra no transporte). Cada tentativa deve respeitar replayability, orçamento,
backoff e cancelamento; o contrato downstream deve definir quando uma resposta
é transferida, consumida ou devolvida ao controlador de retry. Hooks de headers
e hooks de body são fronteiras diferentes: o primeiro pode alterar metadados
antes do transporte, enquanto o segundo participa da leitura/decodificação e
da posse do body.

## 7. Políticas e derivação

Interceptors, hooks, retry predicates/controllers e observers são declarativos
na configuração do cliente. Seus `E` e `R` entram apenas no token que os
declara ou numa derivação explícita. O tipo deve refletir somente as políticas
usadas, com precisão por política: uma política que requer `Clock | Random`
não deve adicionar todos os services do sistema.

`client.use(...interceptors)` retorna um cliente imutavelmente derivado e
acrescenta as uniões de `E` e `R` das novas políticas. Não altera o token
original nem reescreve a tipagem de operações previamente obtidas.

Um observer é um `Program<void, never, R>`: ele pode exigir services, mas não
introduz erro próprio. Middleware e hooks podem introduzir erro e services.
Uma callback effectful arbitrária em `HttpClient.layer` não pode alterar
retroativamente o `E/R` do token standard já declarado.

## 8. Streams

`stream` expõe chunks binários, `ndjson` decodifica itens por Standard Schema e
`sse` expõe eventos. Não é objetivo desta issue criar um `Stream` geral ou um
scheduler.

```ts
type HttpStream<A, E, R extends Service.Any = never> = {
  readonly forEach: <C>(
    consumer: (chunk: A, index: number) => C
  ) => Program<void, E | EffectError<C>, R | EffectRequirements<C>>
  readonly use: <C>(
    consumer: (session: HttpStreamSession<A>) => C
  ) => Program<EffectSuccess<C>, E | EffectError<C>, R | EffectRequirements<C>>
  readonly results: () => Program<readonly A[], E, R>
}
```

Os terminais são lazy e preservam os canais da fonte e do consumidor. A
implementação precisa definir ownership do body, backpressure, cancelamento,
cleanup e o comportamento de body one-shot; uma leitura não deve ser repetida
por um retry se o body não for replayable.

SSE aceita exatamente um dos modos:

- `schema`, que decodifica o payload em um tipo de evento;
- `eventMap`, que mapeia cada nome de evento a um schema e produz uma união
  discriminada `{ type, data }`.

`schema` e `eventMap` não podem coexistir.

## 9. Endpoints

Endpoints declarativos recebem method/path e schemas opcionais para params,
query, body, resposta única ou mapa de respostas. A chamada deve inferir o
input de cada schema e o envelope de retorno sem genéricos manuais ou casts do
consumidor. Se params, query ou body forem declarados, o respectivo campo da
entrada é obrigatório; se não forem declarados, ele não aparece como exigência
inventada.

O probe desta issue usa uma função local `endpoint(...)` apenas para fixar o
contrato de inferência. A escolha da exportação e a implementação pública de
endpoints pertencem à issue #240; este documento não autoriza adicionar essa
API ao pacote agora.

## 10. Imutabilidade e fronteiras de execução

Headers, query e opções são inputs readonly e a preparação da requisição é
imutável. Corpos podem ser mutáveis ou one-shot conforme a plataforma, mas
essa diferença precisa ficar documentada e ser considerada pelo controlador
de retry. Configuração declarativa de client/layer não faz I/O.

Cada execução deve ocorrer no `Runtime`/`Scope` já existente. O programa é
registrado como ativo antes de seu callback rodar, seu child Scope permanece
aberto até a resolução (inclusive se `dispose` for chamado reentrantly), e a
classificação final acontece apenas na fronteira de execução. Valores comuns
com campos `status` não são confundidos com `Result`; somente `Result.ok` e
`Result.err` nominais têm semântica de resultado. O HTTP não cria um Runtime
alternativo nem captura defects de configuração como erros de transporte.

## 11. Probes e matriz de aceitação

Os probes de `tests/types/design/http-contracts.types.ts` verificam, sem
`any`/casts de consumidor para esconder requisitos:

- token default e named token preservam tag literal e instance type;
- sucesso, erro e `R` isolados de operação, `Effect.fn` e `Program.andThen`;
- `Layer.Required`, `Layer.Provided`, Runtime completo e Runtime incompleto;
- `Service.of` estrutural e override compatível/incompatível por tag;
- Standard Schema com input/output diferentes e validação assíncrona;
- resposta status-discriminated, no-content `undefined` e modos SSE
  mutuamente exclusivos;
- políticas, `.use`, observer, middleware e união precisa de `E/R`;
- `forEach` e `use` unem requirements do source e consumer;
- params/query/body/return de endpoint sem genéricos;
- ausência de Promise/thenable e de tipos de provider vazando na fronteira.

Os probes devem compilar no piso TypeScript 6.x suportado pelo pacote e no
compilador atual TypeScript 7.x. Testes de comportamento, transporte,
signals, schema/status, hooks, retry, streams e endpoints são responsabilidade
das issues abaixo, quando seus donos implementarem os contratos.

## 12. Ownership e fora de escopo

| Entrega                            | Issue downstream |
| ---------------------------------- | ---------------- |
| pacote, build e exports públicos   | #231             |
| errors e opções imutáveis          | #232             |
| transporte e services básicos      | #233             |
| AbortSignal/cancelamento           | #234             |
| schema/status/no-content           | #235             |
| hooks/interceptors/middleware      | #236             |
| retry/replayability/ownership      | #237             |
| testes de integração               | #238             |
| endpoints públicos                 | #240             |
| streaming/NDJSON/SSE e seus testes | #243+            |

Ficam fora de #230: cliente executável, adapter `ofetch`, fetch stubs,
integração com container, novo pacote ou manifest/export, reimplementação de
`Result`/`Effect`, mudanças em `Runtime`/`Scope`, publicação npm, tags,
releases e um bridge de lifetime para `WebEffect.handleWith`. Um bridge de
servidor precisa ser opt-in e ter contrato próprio; o handle atual não é
apresentado como solução suficiente.
