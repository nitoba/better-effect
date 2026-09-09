# better-effect-mq-postgres

`better-effect-mq-postgres` torna o PostgreSQL o armazenamento durável de
[`better-effect-mq`](../better-effect-mq). Ele fornece o `JobStore` para
enfileirar, reivindicar e finalizar jobs com segurança entre processos, além de
extensões opcionais para eventos duráveis, schedules, flows e outbox.

O pacote foi feito para aplicações que precisam de jobs que sobrevivam a
reinícios, múltiplos workers e falhas de rede sem adicionar um broker separado.
O PostgreSQL continua sendo a fonte de verdade; o Worker do `better-effect-mq`
cuida do processamento e a sua aplicação continua dona da lógica de negócio.

## Quando usar

Use este adapter quando você já opera PostgreSQL e precisa de:

- jobs duráveis com enqueue, claim, lease, retry, cancelamento e inspeção;
- vários processos ou réplicas consumindo a mesma fila;
- schedules persistentes com tick idempotente;
- um feed de eventos finito para dashboards, auditoria operacional ou esperas
  orientadas a eventos;
- flows com fan-out/fan-in e reconciliação;
- outbox para gravar uma intenção de publicação na mesma transação do domínio.

Ele não transforma PostgreSQL em um sistema de exactly-once. A entrega é
at-least-once: se o processo executar um efeito externo e cair antes de
persistir a finalização, o job pode ser entregue novamente. Torne efeitos
externos idempotentes usando o ID do job ou uma chave de idempotência da sua
aplicação.

## Instalação

Com Bun:

```bash
bun add better-effect-mq-postgres better-effect-mq better-effect better-result better-effect-mq-outbox pg
```

Com npm:

```bash
npm install better-effect-mq-postgres better-effect-mq better-effect better-result better-effect-mq-outbox pg
```

`pg` é um peer opcional. Ele só é carregado quando você usa uma configuração
com `connectionString` (`layerFromConfig`, `PostgresClient.fromConfig` etc.).
Quando você fornece um pool já criado, o adapter usa apenas a interface de pool
e não importa `pg` por conta própria.

## Começo rápido: pool e Layer

O fluxo recomendado é executar a migração como uma etapa explícita do deploy,
validar o schema ao iniciar e então fornecer o pool ao Runtime. A migração não é
executada automaticamente por um Layer.

```ts
import { Pool } from 'pg'
import { Runtime, ServiceRuntime } from 'better-effect'
import { JobName, JobStore, QueueName } from 'better-effect-mq'
import { PostgresJobStore, PostgresMigrator } from 'better-effect-mq-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

await PostgresMigrator.run(pool, { schema: 'public' })
await PostgresMigrator.validate(pool, { schema: 'public' })

const runtime = await Runtime.make(
  PostgresJobStore.layer({
    pool,
    namespace: 'billing'
  })
)

try {
  const enqueued = await runtime.run(async () => {
    const store = await ServiceRuntime.resolve(JobStore)
    return store.enqueue({
      job: {
        queue: QueueName.make('billing').unwrap(),
        name: JobName.make('send-invoice').unwrap(),
        version: 1
      },
      payload: { invoiceId: 'inv_123' },
      metadata: { source: 'billing-api' },
      runAt: Date.now(),
      attemptsMax: 3,
      now: Date.now()
    })
  })

  if (enqueued.isErr()) throw enqueued.error
  console.log(enqueued.value.job.id)
} finally {
  await runtime.dispose()
  await pool.end()
}
```

`layer({ pool })` usa um pool emprestado: o Runtime não o fecha. Feche o pool
no componente que o criou, como no exemplo. Para deixar o adapter criar e ser
responsável pelo pool, use `layerFromConfig`:

```ts
const DurableLive = PostgresJobStore.layerFromConfig({
  connectionString: process.env.DATABASE_URL,
  namespace: 'billing'
})
const runtime = await Runtime.make(DurableLive)

// runtime.dispose() fecha o pool criado pelo adapter.
```

As quatro formas seguem o mesmo padrão:

| Recurso   | Pool fornecido pela aplicação    | Pool criado pelo adapter                   |
| --------- | -------------------------------- | ------------------------------------------ |
| Jobs      | `PostgresJobStore.layer`         | `PostgresJobStore.layerFromConfig`         |
| Events    | `PostgresJobEventStore.layer`    | `PostgresJobEventStore.layerFromConfig`    |
| Schedules | `PostgresJobScheduleStore.layer` | `PostgresJobScheduleStore.layerFromConfig` |
| Outbox    | `PostgresOutbox.layer`           | `PostgresOutbox.layerFromConfig`           |

As variantes `layerFor` e `layerFromConfigFor` permitem fornecer um token
nomeado. O `namespace` separa dados de aplicações ou ambientes que compartilham
o mesmo PostgreSQL; mantenha o mesmo `pool`, `schema` e `namespace` quando dois
Layers precisam acessar o mesmo store.

## Migrações e requisitos

- PostgreSQL 12 ou superior.
- Um schema PostgreSQL que a aplicação possa ler e atualizar.
- A versão do pacote e o schema devem ser atualizados juntos no deploy.

Execute `PostgresMigrator.run(pool, { schema })` em uma etapa controlada de
deploy e mantenha `validateSchema: true` (o padrão) nos Layers de produção. A
validação falha cedo quando o banco está incompleto, pertence a outro
componente ou ainda não foi atualizado para a versão esperada pelo adapter.

O migrator é progressivo, verifica a integridade do que já foi aplicado e não
faz downgrade nem remove dados automaticamente. Para um rollback de aplicação,
restaure um backup compatível ou execute uma migração manual revisada; não
espere que o startup reverta o banco.

Durante um deploy gradual, faça primeiro mudanças compatíveis com as versões em
execução, depois publique o código que as utiliza e só então remova o que ficou
obsoleto. Em ambientes de produção, prefira separar a etapa de migração da
inicialização das réplicas e deixe a validação do adapter como uma segunda
barreira.

## Composição: JobStore, JobEventStore e Runtime

Jobs e eventos são Services do mesmo Runtime. Não crie um Runtime separado para
ler eventos: isso pode produzir pools, escopos e configurações diferentes para
o mesmo namespace.

```ts
import { Layer, Runtime } from 'better-effect'
import { ClockLive } from 'better-effect/standard-services'
import { PostgresJobEventStore, PostgresJobStore } from 'better-effect-mq-postgres'

const DurableLive = Layer.complete(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'billing' }),
    Layer.merge(
      PostgresJobEventStore.layer({
        pool,
        namespace: 'billing',
        retention: {
          count: 100_000,
          ageMs: 7 * 24 * 60 * 60 * 1_000
        }
      }),
      ClockLive
    )
  )
)

const runtime = await Runtime.make(DurableLive)
```

Quando os dois Layers usam o mesmo pool e namespace, as mutações do
`JobStore` passam a alimentar o `JobEventStore` de forma consistente com a
operação durável. O feed pode ser lido com `JobEvents.page`/`JobEvents.forEach`
ou usado por `Job.awaitResult` com `strategy: 'events'` e um `pollFallbackMs`.
O fallback de polling continua sendo a fonte autoritativa quando um sinal de
wake é atrasado ou perdido.

Para stores nomeados, use tokens correspondentes no mesmo Runtime:

```ts
import { JobEventStore, JobStore } from 'better-effect-mq'
import { PostgresJobEventStore, PostgresJobStore } from 'better-effect-mq-postgres'

const Durable = JobStore.named('durable')
const DurableEvents = JobEventStore.for(Durable)

const DurableLive = Layer.merge(
  PostgresJobStore.layerFor(Durable, { pool, namespace: 'billing' }),
  PostgresJobEventStore.layerFor(DurableEvents, {
    pool,
    namespace: 'billing'
  })
)
```

Se a persistência de eventos for obrigatória para todos os writers do
namespace, promova explicitamente o store:

```ts
import { ServiceRuntime } from 'better-effect'
import { JobEventStore } from 'better-effect-mq'

const events = await runtime.run(() => ServiceRuntime.resolve(JobEventStore))
const activation = await events.activate({ mode: 'required', now: Date.now() })
if (activation.isErr()) throw activation.error
```

Faça isso apenas depois que todos os processos do rollout suportarem o EventLog;
caso contrário, uma versão antiga pode continuar gravando jobs sem os eventos
esperados.

## Schedules

`PostgresJobScheduleStore` persiste schedules e suas revisões junto do
`JobStore`. O tick verifica a revisão e o próximo horário esperado, cria as
ocorrências determinísticas e avança o schedule em uma operação única. Repetir
um tick depois de uma resposta perdida não cria a mesma ocorrência duas vezes.

Forneça os dois Layers usando o mesmo pool, schema e namespace:

```ts
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { JobScheduleStore, JobStore } from 'better-effect-mq'
import { PostgresJobScheduleStore, PostgresJobStore } from 'better-effect-mq-postgres'

const runtime = await Runtime.make(
  Layer.merge(
    PostgresJobStore.layer({ pool, namespace: 'billing' }),
    PostgresJobScheduleStore.layer({ pool, namespace: 'billing' })
  )
)

const schedules = await runtime.run(() => ServiceRuntime.resolve(JobScheduleStore))
```

O contrato expõe `upsertSchedule`, `dueSchedules`, `tickSchedule`,
`pauseSchedule`, `resumeSchedule`, `getSchedule`, `listSchedules` e
`removeSchedule`. A decisão de misfire e overlap pertence ao schedule; o
adapter persiste o resultado e mantém a criação do job associada ao tick.

## Flows

Flows são opcionais. Use `PostgresFlowStore` quando a aplicação precisa
coordenar fan-out/fan-in, relatórios de filhos ou reconciliação de cascatas.
Ele é um store explícito, não um Layer do Runtime:

```ts
import { PostgresFlowStore } from 'better-effect-mq-postgres'

const flows = await PostgresFlowStore.make({
  pool,
  namespace: 'billing'
})

try {
  const snapshot = await flows.getFlow({ flowId })
  if (snapshot.isErr()) throw snapshot.error
  console.log(snapshot.value)
} finally {
  await flows.dispose()
}
```

Use `makeFromConfig` quando o adapter deve criar e fechar o pool. Antes de
instanciar o flow store, aplique as migrações atuais e mantenha a validação
habilitada. Se a extensão de flow não estiver presente, a criação falha cedo;
ela não interpreta um schema antigo como se suportasse flows.

As operações de fan-out e relatórios são idempotentes para replays do mesmo
comando. Enfileirar ou cancelar jobs em stores diferentes continua sendo uma
operação at-least-once: não existe uma transação distribuída entre dois
PostgreSQL, dois namespaces ou dois adapters.

## Outbox

O adapter de outbox oferece um `OutboxStore` durável com claim, heartbeat,
publicação, retry, falha, release, recuperação de leases parados, listagem e
contagens. Forneça-o ao mesmo Runtime quando um publisher da aplicação usar o
token `PostgresOutbox`:

```ts
import { Layer, Runtime, ServiceRuntime } from 'better-effect'
import { PostgresOutbox } from 'better-effect-mq-postgres'

const runtime = await Runtime.make(
  PostgresOutbox.layer({
    pool,
    namespace: 'billing'
  })
)

const outbox = await runtime.run(() => ServiceRuntime.resolve(PostgresOutbox))
```

Para garantir que uma mudança de domínio e uma intenção de publicação sejam
confirmadas juntas, prepare o record e chame
`PostgresOutbox.appendIn(transaction, record, { namespace, schema })` dentro da
transação que a aplicação já abriu. `appendIn` não inicia, confirma nem desfaz
essa transação; o chamador continua responsável pelo commit, rollback e
liberação do client.

Use `PostgresOutbox.named('emails')` e `PostgresOutbox.layerFor(...)` quando
precisar de outboxes isolados no mesmo Runtime. A publicação posterior ainda é
at-least-once; o consumidor deve aceitar replays e confirmar o record somente
depois de concluir o efeito externo.

## Eventos, tentativas e observadores

Existem três superfícies complementares. Escolha a que corresponde à pergunta
operacional:

| Superfície                                 | Serve para                                                             | Durabilidade e limites                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `JobEventStore` (EventLog)                 | Feed ordenado de fatos seguros, cursores, dashboards e wakeups         | Durável, mas com retenção finita por `count`, `ageMs` ou ambos; cursores podem expirar |
| `AttemptRecord` via `JobStore.getAttempts` | Histórico detalhado de cada entrega, retry e resultado/falha de um job | Durável com o job; não é feed, não é cursor e pode conter dados sensíveis              |
| `JobObserver` local                        | Logs, métricas, tracing e sinais do processo/Worker                    | Best-effort e process-local; callbacks não são persistidos e não alteram a execução    |

O EventLog omite payloads, resultados, falhas completas e metadados arbitrários
por padrão. Não o use como arquivo histórico infinito nem como substituto do
`AttemptRecord`. O observer também não substitui nenhum dos dois: ele pode
perder eventos em crash, shutdown ou falha do callback.

Ao consumir páginas, persista o cursor somente depois que o handler terminar
com sucesso. Se a retenção já removeu o cursor, o adapter retorna
`JobEventCursorExpiredError`; escolha uma política explícita, como recomeçar do
tail atual, solicitar replay de outra fonte ou falhar de forma visível.

O `awaitEvents` é uma dica de wake. Use o polling limitado como fallback e não
baseie a correção do processamento em qualquer sinal de notificação.

## Garantias e limites operacionais

- **Persistência:** enqueue, claim, lease, settlement, retry, recuperação de
  stalled jobs e as extensões habilitadas usam a unidade transacional do
  PostgreSQL.
- **Concorrência:** leases e tokens impedem que um worker antigo finalize a
  entrega de um worker mais novo. Eles não desfazem um efeito externo já
  executado.
- **Entrega:** é at-least-once. Quedas entre o efeito externo e a finalização
  persistida podem gerar reentrega.
- **Wakeups:** notificações aceleram o worker, mas não são a fonte de verdade;
  o worker deve continuar consultando o estado durável.
- **Retenção:** o EventLog é sempre limitado por política de retenção quando
  você define `count`/`ageMs`; retenção não equivale a backup ou arquivamento.
- **Transações externas:** `appendIn` participa da transação do chamador, mas o
  adapter não coordena transações entre bancos, pools, namespaces ou serviços.
- **Falhas transitórias:** conflitos temporários do banco podem ser reportados
  como retryable; configure retries e backoff no Worker ou na operação que chama
  o store.
- **Capacidade:** pool, conexões, índices, I/O e tamanho das filas continuam
  sendo limites do PostgreSQL. Dimensione o pool e monitore latência antes de
  aumentar a concorrência dos workers.

## Produção

Antes de liberar tráfego:

1. Execute `PostgresMigrator.run` com uma identidade de deploy controlada.
2. Deixe `validateSchema` no padrão (`true`) nos Layers das réplicas.
3. Confirme que workers, schedules, events e outbox usam o mesmo namespace
   quando devem compartilhar estado.
4. Defina retenção de EventLog de acordo com a janela de consumo e mantenha um
   arquivo de auditoria separado quando precisar de histórico ilimitado.
5. Configure heartbeat e lease para que handlers legítimos tenham tempo de
   terminar, e monitore reentregas e recuperação de stalled jobs.
6. Monitore profundidade e idade da fila, jobs ativos, falhas, leases perdidos,
   stalled recovery, latência do banco, uso do pool, atraso de eventos e
   cursores expirados.
7. Teste replays, respostas perdidas, reinício de worker e indisponibilidade
   temporária do banco antes do primeiro rollout.

Se o pool pertence ao host, use `layer`; se o Runtime deve ser o dono do pool,
use `layerFromConfig` e deixe `runtime.dispose()` concluir o ciclo de vida.
Não encerre um pool emprestado enquanto houver Runtime ou operação usando-o.

## Troubleshooting

### O Layer falha na inicialização por schema inválido

Rode `PostgresMigrator.validate(pool, { schema })` com o mesmo schema e
namespace usados pela aplicação. Se ainda não estiver atualizado, execute
`PostgresMigrator.run` na etapa de deploy. Verifique também se a aplicação está
conectando no banco correto e se o usuário pode ler e modificar o schema.

### Um flow não inicia, mas jobs comuns funcionam

Flows exigem a extensão de flow instalada no schema. Atualize o banco antes de
criar `PostgresFlowStore`; não desabilite a validação para contornar o problema
em produção. Se não precisa de flows, use somente `PostgresJobStore`.

### O consumidor recebe `JobEventCursorExpiredError`

O cursor foi removido pela retenção. Recomece de um tail recente ou recupere os
fatos de uma fonte de replay que a sua aplicação mantém. Aumentar `count` ou
`ageMs` ajuda consumidores lentos, mas não cria arquivo infinito.

### Jobs parecem ser executados duas vezes

Isso é possível no modelo at-least-once, especialmente quando o processo cai
antes do settlement ou perde a conexão durante a confirmação. Use uma chave de
idempotência no efeito externo, examine `AttemptRecord` com
`JobStore.getAttempts` e verifique lease/heartbeat do Worker.

### Eventos não aparecem

Confirme que `PostgresJobStore.layer` e `PostgresJobEventStore.layer` usam o
mesmo pool, schema e namespace e pertencem ao mesmo Runtime. Verifique se a
retenção não removeu os eventos e se a ativação obrigatória não está sendo
tentada antes de todos os writers estarem atualizados. Para waits, mantenha o
poll fallback habilitado.

### Outbox ficou com records ativos ou parados

Use `recoverStalled`, confirme que o relógio usado pelo publisher está correto e
verifique a conectividade do pool. `appendIn` só registra o record; claim,
heartbeat e settlement ainda precisam ser executados pelo publisher. O efeito
externo deve ser idempotente porque a confirmação da publicação também pode ser
repetida.

### O pool fecha cedo ou nunca fecha

Pool fornecido pela aplicação (`layer`) é emprestado e deve ser encerrado pelo
host. Pool criado por `layerFromConfig` pertence ao Runtime e é fechado durante
`runtime.dispose()`. Não misture os dois ciclos de vida nem chame `pool.end()`
enquanto o Runtime ainda estiver ativo.

## Mais informações

- [`better-effect-mq`](../better-effect-mq) — contratos de jobs, Worker,
  schedules, eventos e outbox.
- [Guia de composição](../better-effect-mq/docs/composition.md) — regras
  compartilhadas para stores, events, Runtime, retenção e observabilidade.
- [Exemplo de composição](../better-effect-mq/examples/composition/main.ts) —
  um Runtime com `JobStore` e `JobEventStore`.
