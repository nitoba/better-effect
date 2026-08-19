## Why

`better-effect` ainda não oferece uma forma integrada de descrever, carregar e
validar configuração de ambiente usando qualquer biblioteca compatível com
Standard Schema. Exigir que a aplicação declare o schema e depois componha uma
Layer de fonte separada torna o fluxo principal confuso e incentiva parsing
manual fora do Effect.

## What Changes

- Adicionar um Service padrão opcional `Config` no subpath de standard services.
- Adicionar `Config.fromEnv({ schema, dotEnvPath?, envSource? })` como a API
  principal para criar um descritor yieldable de configuração.
- Permitir que o descritor seja consumido diretamente com `yield*` dentro de
  `Effect.gen`, `Effect.fn` e métodos de Services.
- Validar e transformar a fonte internamente através do contrato Standard
  Schema, entregando `StandardSchemaV1.InferOutput<S>` no sucesso.
- Representar falhas de validação e carregamento da fonte no canal de erro do
  Effect/Result, sem expor valores sensíveis da configuração.
- Suportar `process.env`, `Bun.env`, objetos de teste e arquivo `.env` através
  de `envSource` e `dotEnvPath` opcionais.
- Expor APIs avançadas para fornecer uma fonte por Layer e permitir composição
  via o `pipe` funcional existente, sem adicionar um método `.pipe()` aos
  valores.
- Documentar o fluxo recomendado, exemplos dentro de Services, testes com
  fontes substitutas e a compatibilidade com Zod, Valibot e outras bibliotecas
  Standard Schema.
- Não adicionar Zod, Valibot, Effect ou outro validador como dependência de
  runtime.

## Capabilities

### New Capabilities

- `configuration`: Descrição, carregamento, validação e consumo tipado de
  configuração através de Standard Schema e fontes de ambiente substituíveis.

### Modified Capabilities

- `standard-services`: Incluir `Config` como Service opcional normal, sem
  singleton implícito, com Layers de produção, teste e composição compatíveis
  com os contratos existentes.

## Impact

- Novos módulos e exports em `src/standard-services` e no subpath
  `better-effect/standard-services`.
- Novos tipos e erros públicos para configuração, além de metadados de
  requisitos nos descritores consumidos por Effects e Services.
- Novos testes de runtime e de inferência, incluindo fontes in-memory,
  `dotEnvPath`, transformações de schema e erros de validação.
- Atualização da documentação e dos exemplos que atualmente usam um Service
  `Config` específico da aplicação.
- Nenhuma alteração obrigatória nos adaptadores de DI; a fonte de configuração
  permanece um Service/Layer do core e não é movida para um container externo.
