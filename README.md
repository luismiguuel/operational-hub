# CITi Hub

Plataforma operacional para Empresas Juniores. Centraliza projetos, pessoas, planejamento ágil e conhecimento institucional.

## Sobre o projeto

O CITi Hub reúne gestão de projetos com backlog priorizado, sprints e carryover transacional; gestão de pessoas, áreas e capacidade semanal; termômetro de saúde dos projetos; radar de sobrecarga; e Memória Institucional com busca RAG usando `pgvector` e processamento assíncrono com BullMQ.

## Arquitetura e stack

- `apps/api`: API Fastify em TypeScript, PostgreSQL com `pgvector`, Redis e workers BullMQ.
- `apps/web`: SPA React com Vite, Tailwind CSS e TanStack Query.
- `packages/shared`: schemas Zod, tipos e contratos compartilhados.

## Pré-requisitos

- Node.js `>=22.13.0` (há versões padrão em `.nvmrc` e `.node-version`).
- pnpm `10.32.1`.
- Docker com Docker Compose, para executar PostgreSQL e Redis localmente.

## Executar localmente

Clone o repositório e instale as dependências:

```bash
git clone <url-do-repositorio>
cd operational-hub
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
```

Prepare o ambiente e o banco. O setup cria `.env` a partir de `.env.example` se necessário, inicia os serviços definidos em `compose.yaml`, aplica as migrações e executa o seed:

```bash
pnpm run setup
```

Inicie a aplicação e o worker em terminais separados:

```bash
# Terminal 1: API e frontend
pnpm dev
```

```bash
# Terminal 2: worker BullMQ para tarefas assíncronas
pnpm worker
```

Acesse o frontend em <http://localhost:5173>. A API fica em <http://localhost:3001> (base REST: `/api/v1`). O seed cria a conta administrativa inicial usando `SEED_ADMIN_EMAIL` e `SEED_ADMIN_PASSWORD` do `.env`; altere essas credenciais antes de qualquer uso compartilhado. Para diagnosticar configuração e portas, execute `pnpm run doctor`.

Para preparar o banco manualmente, use `docker compose up -d --wait`, `pnpm db:migrate` e `pnpm db:seed`.

## Scripts úteis

| Comando                 | Uso                                                      |
| ----------------------- | -------------------------------------------------------- |
| `pnpm run doctor`       | Verifica Node, `.env` e serviços/portas locais.          |
| `pnpm test`             | Executa testes unitários da API.                         |
| `pnpm test:integration` | Executa testes de integração; requer PostgreSQL e Redis. |
| `pnpm typecheck`        | Verifica os tipos TypeScript dos pacotes.                |
| `pnpm lint`             | Executa ESLint no repositório.                           |
| `pnpm build`            | Compila e valida os pacotes.                             |
