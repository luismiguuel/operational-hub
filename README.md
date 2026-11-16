# CITi Hub · Operational Hub

Fundação de um sistema de gestão para Empresas Juniores. Monorepo TypeScript estrito, ESM, monólito modular com eventos e SPA React. A marca **CITi Hub** e os grafismos são placeholders originais; a apresentação usa a skill [citi-visual-language](.agents/skills/citi-visual-language/SKILL.md).

## Executar localmente

Requisitos: Node **20.19+** (recomendado 22 LTS), Docker Compose e pnpm **10.32.1**. Se o `pnpm` global for incompatível com seu Node, use `npx --yes pnpm@10` em seu lugar.

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

Edite `.env`: defina `JWT_SECRET` aleatório com pelo menos 32 caracteres e `SEED_ADMIN_PASSWORD` com pelo menos 12. O administrador inicial usa `SEED_ADMIN_EMAIL`. Para explorar dados **explicitamente ilustrativos**, escolha `SEED_DEMO=true` **antes do primeiro seed**. Não há senha padrão nem cadastro público. O seed preserva contas existentes; não é uma ferramenta de reset de senha.

```bash
docker compose up -d --wait
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Abra <http://localhost:5173>. Em outro terminal:

```bash
pnpm worker
```

O worker publica a outbox e processa resumos de IA. A API usa a porta de `PORT` (padrão 3001); o proxy Vite lê a mesma configuração. Se 5432 estiver ocupada, altere **POSTGRES_PORT e DATABASE_URL** juntos. Para Redis, ajuste **REDIS_PORT e REDIS_URL**. Neste workspace, a configuração local usa PostgreSQL **55432** e API **3301**, pois as portas padrão já estavam ocupadas. O `.env` local, ignorado pelo Git, já foi preparado com senha aleatória e dados demonstrativos.

## Entrega desta fundação

- Diretório de pessoas com área, subárea, cargo, capacidade semanal e papel de sistema independente da área. Criação/edição pela diretoria; ativação/desativação via API.
- Catálogo externo/interno, criação, arquivamento/reativação e alocações contextuais com horas planejadas.
- Épicos e tarefas, backlog por `sprintId=null`, prioridades, pontos Fibonacci, tags, Markdown sanitizado, responsável único opcional no planejamento, checklist, links HTTPS e comentários.
- Sprints planejadas/ativas/encerradas. Planeje o escopo **antes** de iniciar. Apenas uma sprint ativa por projeto. Inclusão, remoção e alteração de pontos/épico/tipo são bloqueadas após o início. Encerre após concluir as tarefas; carryover e reabertura são evoluções futuras.
- Kanban com `@dnd-kit`, atualizações otimistas, rollback em erro, concorrência por versão e seletor de status acessível por teclado.
- Meu Espaço, mapa de alocação, totais de entrega e velocidade das últimas seis sprints encerradas. Horas e story points permanecem medidas independentes.
- OAuth Google Workspace com PKCE, state, nonce, validação OIDC e vínculo apenas a usuários previamente provisionados; login local Argon2id para o administrador inicial.
- JWT de 15 minutos mantido em memória; refresh rotativo em cookie HttpOnly/SameSite=Strict, com detecção de replay por família. Secure obrigatório em produção; exceção explícita em HTTP local.
- WebSockets autenticados por primeira mensagem, segmentados por projeto, com revalidação de vínculo a cada entrega e reconexão do cliente. Nenhum token em URL.
- PostgreSQL/pgvector, índices GIN, tabela e índice vetorial para a futura memória institucional; Redis para cache, rate limit, Pub/Sub e BullMQ; auditoria append-only e outbox transacional.
- Resumo de projeto por IA, assíncrono, autorizado, auditado e sujeito a revisão humana. Sem chave, a API retorna 503 explicando a configuração ausente.

## Configurar integrações

**Google:** crie um cliente OAuth de aplicação web e cadastre exatamente `GOOGLE_CALLBACK_URL`. Preencha `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e, para restringir à organização, `GOOGLE_WORKSPACE_DOMAIN`. Os e-mails devem ser provisionados antes pela diretoria. Novas pessoas criadas na UI entram por SSO; o sistema não gera senhas para elas.

**IA:** configure `AI_API_KEY`, `AI_BASE_URL` e `AI_MODEL` para um provedor compatível com Chat Completions. A UI informa os campos enviados e exige ação explícita. O contexto contém somente o projeto autorizado (até 100 tarefas recentes); nenhum modelo altera dados. A integração real com Google e o provedor de IA exige suas credenciais e não faz parte dos testes locais.

## Qualidade

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm test:integration
pnpm build
```

A suíte de integração requer PostgreSQL e Redis ativos. Cria um banco temporário com nome aleatório, aplica o schema e o remove ao final; o usuário de teste precisa de `CREATEDB`. Nunca apaga o banco configurado. Verifica RBAC contextual/BOLA, concorrência, fechamento de escopo, auditoria imutável, rotação/replay de refresh e salas WebSocket.

Para o smoke de navegador (requer seed demonstrativo):

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

O teste abre desktop e mobile, autentica, verifica ausência de overflow, abre um card, valida arraste e persistência após recarregar no desktop, acessa o mapa de alocação e encerra a sessão. Screenshots são gerados em `/tmp/citi-hub-desktop.png` e `/tmp/citi-hub-mobile.png`. Traces estão desabilitados para evitar capturar credenciais. Dependências nativas do Chromium podem exigir instalação pelo administrador do ambiente.

## Estrutura e decisões

```text
apps/api/src/
  core/         configuração, banco, políticas, Redis, barramento e outbox
  modules/      autenticação, diretório, projetos/sprints, tarefas, dashboards, realtime
  scripts/      migração e seed em TypeScript
  tests/        políticas e integração de segurança
apps/web/src/
  core/         transporte tipado, sessão em memória, UI e WebSocket
  features/     login, workspace, cards, métricas e visões operacionais
packages/shared/src/  schemas Zod, DTOs, RBAC e eventos
```

Consulte [arquitetura e limites](docs/architecture.md) e [contrato REST](docs/api.md). As taxonomias de áreas/subáreas e papéis são deliberadamente estáticas nesta fundação; o administrador administra seus vínculos nos perfis. Gestão dinâmica dessas taxonomias, RAG com ingestão/embeddings/busca, burndown histórico e IA em outros pontos da operação ainda precisam de implementação. Timesheet, financeiro, chat nativo e sincronizações bidirecionais permanecem fora da v1.

O build da SPA fica em `apps/web/dist`. API e worker executam fontes TypeScript com `tsx`; o build faz verificação/compilação TypeScript. Hospede API/worker em Node com acesso TCP a PostgreSQL/Redis e sirva a SPA com fallback para `index.html`, encaminhando `/api` e upgrades WebSocket à API. Não há publicação externa nem infraestrutura de produção provisionada.

## Convenção de commits e branches

- Cada commit deve ser pequeno, atômico e representar uma única responsabilidade lógica, mantendo o repositório íntegro.
- Use exclusivamente mensagens Conventional Commits em texto puro, sem emojis (por exemplo: `feat(api): ...`, `fix(web): ...`, `docs: ...`).
- Trabalhe exclusivamente com branches: crie e alterne branches no diretório raiz do repositório; não use Git worktrees.
