# better-effect-mq-mongodb

Adapter MongoDB para os serviços duráveis de [`better-effect-mq`](../better-effect-mq): filas de jobs, schedules, flows, eventos e outbox. A aplicação continua usando as APIs de `better-effect-mq`; este pacote fornece apenas as Layers que conectam essas APIs a um banco MongoDB.

## O que resolve e quando escolher MongoDB

Escolha este adapter quando a aplicação já opera MongoDB e precisa de:

- jobs duráveis com enqueue, claim, settlement, retry, cancelamento, pausa, retomada e inspeção;
- isolamento por namespace e suporte a múltiplas filas ou stores no mesmo banco;
- operações transacionais para mudanças de estado, schedules, flows e outbox;
- eventos duráveis opcionais, com retenção por idade ou quantidade;
- um único modelo operacional para o estado da aplicação e o estado das filas.

MongoDB é uma boa opção quando payloads BSON/documentos, a operação existente do cluster e transações multi-documento são importantes. Prefira um adapter relacional quando relatórios relacionais e ferramentas SQL forem a prioridade, ou Redis/Valkey quando a prioridade for latência mínima em filas.

O pacote não inicia workers nem define jobs. Esses comportamentos pertencem a `better-effect-mq` e podem usar o mesmo Runtime que fornece esta Layer.

## Instalação

```bash
bun add better-effect-mq-mongodb better-effect better-effect-mq better-effect-mq-outbox better-result mongodb
```

Os peers públicos são:

| Pacote                    | Faixa                           |
| ------------------------- | ------------------------------- |
| `better-effect`           | `>=0.13.0 <0.14.0`              |
| `better-effect-mq`        | `>=0.1.0 <0.2.0`                |
| `better-effect-mq-outbox` | `>=0.1.0 <0.2.0`                |
| `better-result`           | `^3.0.0`                        |
| `mongodb`                 | `>=6.0.0 <8.0.0`, peer opcional |
| `typescript`              | `>=6.0.0`                       |

`mongodb` é opcional porque o adapter aceita um `Db` já criado pela aplicação. Nesse caminho, importar o pacote não carrega o driver. Use o peer `mongodb` quando quiser que `layerFromConfig` abra a conexão para você.

## Quick start: um `Db` da aplicação e uma Layer

O fluxo recomendado é conectar o cliente, executar a migração explicitamente e fornecer o `Db` ao adapter:

```ts
import { MongoClient } from 'mongodb'
import { Effect, Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { Codec, Queue } from 'better-effect-mq'
import { Result } from 'better-result'
import { MongoJobStore } from 'better-effect-mq-mongodb'

const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0'
const client = new MongoClient(uri)
await client.connect()
const db = client.db('application')

await MongoJobStore.migrate({ db })

const Emails = Queue.define('emails')
const SendEmail = Emails.job('send', {
  version: 1,
  payload: Codec.json<{ readonly to: string }>()
})

const ApplicationLive = Layer.complete(
  Layer.merge(MongoJobStore.layer({ db, namespace: 'application' }), ClockLive)
)
const runtime = await Runtime.make(ApplicationLive)

try {
  const result = await runtime.run(() =>
    Effect.gen(async function* () {
      const jobId = yield* SendEmail.enqueue(
        { to: 'ada@example.test' },
        { idempotencyKey: 'welcome-ada' }
      )
      return Result.ok(jobId)
    })
  )

  if (Result.isError(result)) throw result.error
  console.log(result.value)
} finally {
  await runtime.dispose()
  await client.close()
}
```

O `Db` deve ser o `Db` do driver oficial e manter acesso ao seu `MongoClient` (`db.client`), necessário para abrir sessões transacionais.

O worker, os handlers e a leitura do resultado usam somente `better-effect-mq`. Por exemplo, um worker pode ser adicionado à mesma `ApplicationLive` com `Worker.service` e `Worker.handle`, sem consultar coleções nem conhecer MongoDB. Consulte o [guia de composição de `better-effect-mq`](../better-effect-mq/docs/composition.md) para esse lado da aplicação.

### Cliente gerenciado pelo adapter

Quando preferir passar uma URI em vez de um `Db`, use a Layer equivalente:

```ts
const StoreLive = MongoJobStore.layerFromConfig({
  uri,
  database: 'application',
  namespace: 'application'
})
```

`layerFromConfig` cria e fecha o `MongoClient` junto com o Runtime. A migração continua sendo uma operação explícita e deve ser executada com um `Db` administrativo antes de iniciar a aplicação.

## Migrações e requisitos operacionais

Antes da primeira execução de uma Layer, aplique a migração correspondente:

```ts
await MongoJobStore.migrate({ db })
```

O comando é idempotente. A Layer valida o layout existente por padrão (`validateLayout: true`) e falha cedo quando a migração está ausente ou incompatível; ela não altera o banco automaticamente. `collectionPrefix` permite separar instalações do adapter no mesmo banco, e `namespace` separa stores lógicos da aplicação.

Se a aplicação usar flows, aplique também a migração de flows depois da migração principal:

```ts
import { MongoFlowStore, MongoJobStore } from 'better-effect-mq-mongodb'

await MongoJobStore.migrate({ db })
await MongoFlowStore.migrate({ db })
```

Schedules, eventos e outbox usam a migração principal; não há uma migração automática durante a aquisição dessas Layers.

O MongoDB precisa aceitar transações: use um replica set (um replica set de um único nó é suficiente para desenvolvimento) ou um deployment mongos compatível com transações. MongoDB standalone é rejeitado quando a Layer é adquirida. Esse requisito vale para jobs, schedules, flows e outbox.

> **Ownership do `Db`:** `MongoJobStore.layer`, `MongoJobScheduleStore.layer`, `MongoFlowStore.layer`, `MongoJobEventStore.layer` e `MongoOutboxStore.layer` usam o `Db` fornecido, mas não fecham o `MongoClient` da aplicação. O código que criou o cliente deve fechá-lo depois de `runtime.dispose()`. As variantes `layerFromConfig` criam o cliente e assumem esse fechamento.

Recomendações de operação:

- mantenha `validateLayout` habilitado em produção;
- configure backups, retenção, monitoramento, capacidade de índices e limites de tamanho de documento conforme o volume da aplicação;
- escolha `notifications: 'poll'` quando change streams não estiverem disponíveis; o modo padrão (`'auto'`) usa change streams apenas como sinal de despertar e mantém polling como fallback;
- mantenha `collectionPrefix` estável depois de uma migração e use o mesmo valor em todas as Layers que compartilham o layout.

## Composição com `better-effect-mq` e eventos

`better-effect-mq` define o contrato de `JobStore`. A Layer do adapter fornece esse contrato:

```ts
import { JobStore } from 'better-effect-mq'
import { MongoJobStore } from 'better-effect-mq-mongodb'

const Durable = JobStore.named('durable')
const DurableStoreLive = MongoJobStore.layerFor(Durable, {
  db,
  namespace: 'application'
})
```

Use `layerFor` quando vários stores precisarem coexistir no mesmo Runtime. Jobs associados ao token `Durable` devem ser fornecidos por essa Layer; a aplicação não precisa fazer resolução manual de serviços.

### Eventos duráveis

Eventos são opcionais. Para fornecer o `JobStore` e o `JobEventStore` juntos, use:

```ts
import { MongoJobStore } from 'better-effect-mq-mongodb'

const DurableWithEvents = MongoJobStore.layerWithEvents(
  { db, namespace: 'application' },
  { retention: { ageMs: 7 * 24 * 60 * 60 * 1_000, count: 100_000 } }
)
```

Também é possível fornecer somente `MongoJobEventStore.layer(...)` ou associar o evento a um token nomeado com `layerFor`. A leitura usa cursores monotônicos e paginação; cursores além da retenção retornam erro de expiração. O log registra transições seguras, não payloads de jobs, resultados, falhas completas ou metadados arbitrários.

Com `layerWithEvents`, a transição do job e seu evento são confirmados ou desfeitos juntos. A espera por eventos pode usar change streams como uma dica de baixa latência, mas mantém polling para recuperar reconexões e lacunas. A publicação de eventos para sistemas externos continua sendo responsabilidade da aplicação.

## Capacidades disponíveis

### Filas e controles

O adapter implementa o `JobStore` usado por `better-effect-mq`: enqueue idempotente, claim concorrente, settlement com resultado ou retry, cancelamento, recuperação de jobs interrompidos, pausa/retomada e consultas limitadas. Ele também suporta os controles de fila expostos por `better-effect-mq`, incluindo concorrência global, concorrência por chave e limite por janela de tempo.

O `Worker` de `better-effect-mq` continua sendo responsável por executar handlers, supervisionar tentativas e encerrar de forma ordenada. A Layer MongoDB fornece apenas a persistência necessária para esses ciclos.

### Schedules

Schedules são fornecidos em uma Layer separada:

```ts
import { JobScheduleStore } from 'better-effect-mq'
import { MongoJobScheduleStore } from 'better-effect-mq-mongodb'

const SchedulesLive = MongoJobScheduleStore.layer({
  db,
  namespace: 'application'
})
```

Componha `SchedulesLive` com a Layer do `JobStore` associado. Ticks usam uma operação transacional de compare-and-set, inserem ocorrências determinísticas, acordam a fila e avançam o schedule como uma única mudança observável. Para stores nomeados, crie o token associado e forneça-o explicitamente:

```ts
const DurableSchedules = JobScheduleStore.for(Durable)
const NamedSchedulesLive = MongoJobScheduleStore.layerFor(DurableSchedules, {
  db,
  namespace: 'application'
})
```

### Flows

Flows usam uma Layer explícita e uma migração própria:

```ts
import { MongoFlowStore } from 'better-effect-mq-mongodb'

const FlowLive = MongoFlowStore.layer({
  db,
  namespace: 'application'
})
```

O adapter persiste fan-out de filhos, resultados de filhos, cancelamento, reconciliação e relatórios pendentes para entrega ao pai. A entrega é pelo menos uma vez e pode ser repetida com segurança. Stores diferentes não participam de uma única transação; não há garantia de commit atômico entre bancos ou namespaces.

### Outbox

Para o `OutboxStore` de [`better-effect-mq-outbox`](../better-effect-mq-outbox/README.md), use:

```ts
import { MongoOutboxStore, OutboxStore } from 'better-effect-mq-mongodb'

const OutboxLive = MongoOutboxStore.layer({
  db,
  namespace: 'billing'
})

const NamedOutboxLive = MongoOutboxStore.layerFor(OutboxStore.named('billing'), {
  db,
  namespace: 'billing'
})
```

`MongoOutbox.appendIn(session, record, options)` integra um registro a uma transação MongoDB que a aplicação já abriu. A aplicação é dona da sessão, do commit/abort e de `endSession()`. Depois do commit, o `OutboxStore` oferece claims com expiração, heartbeat, settlement e recuperação; a publicação externa é pelo menos uma vez e deve ser confirmada explicitamente com `markPublished`.

## Garantias de durabilidade e limites

- As mudanças mutáveis do adapter usam transações MongoDB com leitura snapshot e confirmação `majority`.
- Enqueue, claim, settlement, retry, cancelamento, schedules, flows e operações do outbox têm uma unidade atômica no mesmo banco e namespace.
- Repetições de uma operação idempotente não criam um segundo estado lógico; respostas perdidas podem ser repetidas pelo chamador.
- A entrega de jobs, eventos consumidos e outbox é pelo menos uma vez. Consumidores devem persistir seus cursores ou confirmações e tolerar duplicatas.
- Change streams são apenas uma otimização de despertar; indisponibilidade ou reconexão não deve ser tratada como perda de estado.
- O adapter não fornece transações distribuídas, exactly-once para publicação externa, filas entre bancos, armazenamento ilimitado de eventos ou backups automáticos.
- O tamanho máximo dos documentos, a capacidade de índices, a retenção e a recuperação de backups continuam sendo limites e responsabilidades do ambiente MongoDB.

Para a API de jobs, workers, schedules e flows, consulte a [documentação pública de `better-effect-mq`](../better-effect-mq/README.md). Para detalhes específicos de operação do MongoDB, consulte a documentação do deployment usado pela aplicação.
