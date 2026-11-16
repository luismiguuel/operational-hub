# Contrato REST v1

Base `/api/v1`. Schemas e DTOs vivem em `packages/shared/src/index.ts`. Todas as rotas, exceto autenticação e health, exigem `Authorization: Bearer <accessToken>`. IDs são UUIDs. JSON inválido retorna 400; sessão inválida, 401; ação sem permissão, 403; recurso fora do escopo, 404; conflito/versão antiga, 409; vínculo inválido, 422; integração ausente, 503.

| Método e caminho                                        | Finalidade / autorização                                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET `/health`                                           | Readiness de PostgreSQL e Redis                                                                |
| GET `/auth/providers`                                   | Provedores habilitados                                                                         |
| POST `/auth/login`                                      | E-mail/senha; 8 tentativas/minuto/IP                                                           |
| POST `/auth/refresh`                                    | Renova e rotaciona cookie; Origin do frontend                                                  |
| POST `/auth/logout`                                     | Revoga família e remove cookie                                                                 |
| GET `/auth/me`                                          | Perfil autenticado                                                                             |
| GET `/auth/google`                                      | Inicia Google OAuth                                                                            |
| GET `/auth/google/callback`                             | Valida retorno e redireciona à SPA                                                             |
| GET `/areas`                                            | Catálogo fixo de áreas/subáreas                                                                |
| GET `/users`                                            | Diretório dentro do escopo do ator                                                             |
| POST `/users`                                           | Provisionar perfil; admin                                                                      |
| PATCH `/users/:id`                                      | Atualizar perfil completo; admin                                                               |
| PATCH `/users/:id/active`                               | `{active: boolean}`; admin, impede autodesativação                                             |
| GET `/audit?limit=50`                                   | Últimos registros; limite 1–100, admin                                                         |
| GET `/projects`                                         | Projetos visíveis, incluindo arquivados                                                        |
| POST `/projects`                                        | Criar; admin                                                                                   |
| PATCH `/projects/:projectId`                            | `{archived: boolean}`; admin                                                                   |
| GET `/projects/:projectId/allocations`                  | Pessoas vinculadas                                                                             |
| PUT `/projects/:projectId/allocations`                  | Upsert de vínculo/horas; líder contextual/admin                                                |
| GET `/projects/:projectId/sprints`                      | Ciclos do projeto                                                                              |
| POST `/projects/:projectId/sprints`                     | Criar planejada; líder contextual/admin                                                        |
| PATCH `/projects/:projectId/sprints/:sprintId`          | `{state: 'ACTIVE' \| 'CLOSED'}`; carryover abaixo; líder contextual/admin                      |
| GET `/projects/:projectId/tasks`                        | Tarefas e épicos do projeto                                                                    |
| POST `/projects/:projectId/tasks`                       | Membro cria tarefa própria no backlog; líder/admin pode atribuir e selecionar sprint planejada |
| PATCH `/projects/:projectId/tasks/:taskId`              | Patch com `version` obrigatório; membro limitado a execução de cards próprios                  |
| GET, POST `/projects/:projectId/tasks/:taskId/comments` | Discussão contextual; `body` em Markdown                                                       |
| GET `/me/tasks`                                         | Tarefas próprias de projetos ativos, por prioridade e prazo                                    |
| GET `/dashboards/heat`                                  | Admin/Gente e Gestão global; líderes limitados aos próprios projetos                           |
| GET `/projects/:projectId/metrics`                      | Entregas, pontos e velocidade de sprints encerradas                                            |
| GET `/projects/:projectId/activity`                     | Últimas 30 transições de status                                                                |
| POST `/projects/:projectId/ai/summary`                  | Enfileira resumo; líder contextual/admin; retorna 202 `{id}`                                   |
| GET `/projects/:projectId/ai/jobs/:jobId`               | Estado/resultado; mesma pessoa solicitante e mesmo projeto                                     |
| WS `/ws/projects/:projectId`                            | Origin restrito; primeira mensagem tipada de autenticação, prazo de 5s                         |

Exemplo de atualização:

```ts
const changes = { status: 'IN_PROGRESS', version: task.version };
// PATCH /api/v1/projects/{projectId}/tasks/{taskId}
// Em 200, use o card retornado com version incrementado.
// Em 409, recarregue e revise a alteração concorrente antes de reenviar.
```

Conexão WebSocket recebe `{type: 'authenticate', accessToken}` e responde `{type: 'ready', projectId}`. Eventos `TaskStatusChanged` contêm id, projectId, taskId, actorId, from, to e occurredAt. Trate id como chave de deduplicação caso adicione consumidores com efeitos colaterais.

No encerramento (`state: 'CLOSED'`), o PATCH de sprint aceita `unfinishedAction: 'BACKLOG' | 'NEXT_SPRINT'` (padrão `BACKLOG`) e `targetSprintId`, obrigatório para `NEXT_SPRINT`. O destino deve estar planejado no mesmo projeto. Sprint inválida retorna 400 ou 404; transição inválida retorna 409.
