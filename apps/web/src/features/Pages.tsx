import { HealthBadge } from './HealthBadge';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  allocationOverloadSummarySchema,
  projectHealthReportSchema,
  projectSchema,
  taskSchema,
} from '@hub/shared';
import type { Project } from '@hub/shared';
import { ArrowUpRight, Plus, BriefcaseBusiness, Layers, Archive } from 'lucide-react';
import { api, post, patch, ok, useSession, useUI } from '../core/api';
import { Empty, ErrorMessage, Avatar, Modal, dateLabel } from '../core/components';
export function Projects({ projects }: { projects: Project[] }) {
  const client = useQueryClient(),
    admin = useSession((s) => s.user?.role === 'ADMIN'),
    setProject = useUI((s) => s.setProject);
  const health = useQuery({
    queryKey: ['project-health'],
    queryFn: () => api('/projects/health', z.array(projectHealthReportSchema)),
    refetchInterval: 30000,
  });
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState('ALL');
  const create = useMutation({
    mutationFn: (input: unknown) => api('/projects', projectSchema, post(input)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
    },
  });
  const archive = useMutation({
    mutationFn: (p: Project) => api(`/projects/${p.id}`, ok, patch({ archived: !p.archived })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['projects'] });
    },
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CONEXÕES QUE GERAM IMPACTO</p>
          <h1>Projetos</h1>
          <p className="muted">Uma visão compartilhada de tudo o que estamos construindo.</p>
        </div>
        {admin && (
          <button className="primary" onClick={() => setOpen(true)}>
            <Plus size={18} /> Novo projeto
          </button>
        )}
      </div>
      <div className="toolbar">
        {[
          ['ALL', 'Todos'],
          ['EXTERNAL', 'Clientes'],
          ['INTERNAL', 'Operação interna'],
        ].map(([value, label]) => (
          <button
            key={value}
            className={`filter ${kind === value ? 'selected' : ''}`}
            onClick={() => setKind(value ?? 'ALL')}
          >
            {label}
          </button>
        ))}
      </div>
      <ErrorMessage error={archive.error} />
      <div className="project-grid">
        {projects
          .filter((p) => kind === 'ALL' || p.kind === kind)
          .map((p) => (
            <article className="project-card" key={p.id}>
              <div className="project-card-header">
                {p.kind === 'EXTERNAL' ? <BriefcaseBusiness size={22} /> : <Layers size={22} />}
                <span className="eyebrow">
                  {p.kind === 'EXTERNAL' ? 'CLIENTE' : 'INTERNO'}
                  {p.archived ? ' · ARQUIVADO' : ''}
                </span>
              </div>
              <h2>{p.name}</h2>
              {health.data?.find((report) => report.projectId === p.id) && (
                <HealthBadge report={health.data.find((report) => report.projectId === p.id)!} />
              )}
              <p className="muted">{p.description || 'Um novo espaço para construir em equipe.'}</p>
              <div className="project-card-footer">
                <button className="text-button" onClick={() => setProject(p.id)}>
                  Abrir workspace <ArrowUpRight size={17} />
                </button>
                {admin && (
                  <button
                    className="icon-button"
                    aria-label={p.archived ? 'Reativar projeto' : 'Arquivar projeto'}
                    title={p.archived ? 'Reativar projeto' : 'Arquivar projeto'}
                    disabled={archive.isPending}
                    onClick={() => archive.mutate(p)}
                  >
                    <Archive size={17} />
                  </button>
                )}
              </div>
            </article>
          ))}
      </div>
      {projects.length === 0 && (
        <Empty
          title="O próximo impacto começa aqui"
          detail="A diretoria pode criar projetos e vincular o time para liberar o workspace."
        />
      )}
      <Modal open={open} onOpenChange={setOpen} title="Um novo projeto">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(Object.fromEntries(new FormData(e.currentTarget)));
          }}
        >
          <label>
            Nome
            <input name="name" minLength={3} required />
          </label>
          <label>
            Tipo
            <select name="kind">
              <option value="EXTERNAL">Externo · Cliente</option>
              <option value="INTERNAL">Interno · Operação</option>
            </select>
          </label>
          <label>
            Contexto
            <textarea name="description" maxLength={5000} />
          </label>
          <ErrorMessage error={create.error} />
          <button className="primary" disabled={create.isPending}>
            Criar projeto <ArrowUpRight size={17} />
          </button>
        </form>
      </Modal>
    </>
  );
}
export function MySpace({ projects }: { projects: Project[] }) {
  const tasks = useQuery({
      queryKey: ['mine'],
      queryFn: () => api('/me/tasks', z.array(taskSchema)),
      refetchInterval: 30000,
    }),
    setProject = useUI((s) => s.setProject);
  const [done, setDone] = useState(false),
    items = tasks.data?.filter((t) => done || t.status !== 'DONE') ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">FOCO NO QUE IMPORTA</p>
          <h1>Meu espaço</h1>
          <p className="muted">Suas entregas, conectadas. Um passo de cada vez.</p>
        </div>
      </div>
      <div className="toolbar">
        <label className="checklist-item">
          <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
          Incluir concluídas
        </label>
        <span className="quiet">{items.length} tarefas</span>
      </div>
      <ErrorMessage error={tasks.error} />
      {tasks.isPending && <p role="status">Carregando suas tarefas…</p>}
      {!tasks.isPending && items.length === 0 && (
        <Empty
          title="Espaço para respirar"
          detail="Você não tem tarefas nesta visão. Suas próximas entregas aparecerão aqui."
        />
      )}
      {items.map((t) => (
        <button className="my-task" key={t.id} onClick={() => setProject(t.projectId)}>
          <span className={`priority-dot ${t.priority.toLowerCase()}`} />
          <div>
            <strong>{t.title}</strong>
            <small className="muted">
              {projects.find((p) => p.id === t.projectId)?.name ?? 'Projeto'}
            </small>
          </div>
          <span className="tag">{t.points} pts</span>
          <span>{dateLabel(t.dueDate)}</span>
          <ArrowUpRight size={18} />
        </button>
      ))}
    </>
  );
}
export function Heat() {
  const [risk, setRisk] = useState('ALL');
  const radar = useQuery({
    queryKey: ['allocation-radar'],
    queryFn: () => api('/allocation/radar', allocationOverloadSummarySchema),
    refetchInterval: 15000,
  });
  const data = radar.data;
  return (
    <>
      <div className="page-heading">
        <h1>Mapa de alocação</h1>
      </div>
      <ErrorMessage error={radar.error} />
      {radar.isPending && <p role="status">Carregando alocação…</p>}
      {data && (
        <>
          <div className="metric-strip">
            <div>
              <strong>{data.totals.overloadedCount}</strong>
              <span>Membros em Sobrecarga</span>
            </div>
            <div>
              <strong>{data.totals.nearLimitCount}</strong>
              <span>Próximos do Limite</span>
            </div>
            <div>
              <strong>{data.totals.availableHoursTotal} h</strong>
              <span>Horas Livres na EJ</span>
            </div>
          </div>
          <label className="radar-filter">
            Nível de risco
            <select value={risk} onChange={(e) => setRisk(e.target.value)}>
              <option value="ALL">Todos</option>
              <option value="OVERLOADED">Sobrecarga &gt; 100%</option>
              <option value="NEAR_LIMIT">Limite ≥ 85%</option>
              <option value="OPTIMAL">Ideal &lt; 85%</option>
            </select>
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pessoa / área</th>
                  <th>Alocação semanal</th>
                  <th>Ocupação</th>
                  <th>Tarefas abertas</th>
                  <th>Story points</th>
                </tr>
              </thead>
              <tbody>
                {data.members
                  .filter((m) => risk === 'ALL' || m.riskLevel === risk)
                  .map((m) => (
                    <tr key={m.userId}>
                      <td>
                        <div className="person">
                          <Avatar name={m.name} />
                          <div>
                            <strong>{m.name}</strong>
                            <small>{m.area}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {m.allocatedHours}h / {m.weeklyCapacityHours}h
                      </td>
                      <td>
                        <div
                          className={`heat-bar ${m.riskLevel === 'OVERLOADED' ? 'overloaded' : m.riskLevel === 'NEAR_LIMIT' ? 'busy' : ''}`}
                        >
                          <span style={{ width: `${Math.min(m.utilizationPercent, 100)}%` }} />
                        </div>
                        <small>
                          {m.utilizationPercent}% ·{' '}
                          {m.riskLevel === 'OVERLOADED'
                            ? 'Sobrecarga'
                            : m.riskLevel === 'NEAR_LIMIT'
                              ? 'Próximo do limite'
                              : 'Ideal'}
                        </small>
                      </td>
                      <td>{m.activeTasksCount}</td>
                      <td>{m.activeStoryPoints}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {data.members.filter((m) => risk === 'ALL' || m.riskLevel === risk).length === 0 && (
            <p className="muted">Nenhum membro neste filtro.</p>
          )}
        </>
      )}
    </>
  );
}
