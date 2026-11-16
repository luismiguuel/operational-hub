import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { z } from 'zod';
import {
  statusLabels,
  statusSchema,
  taskSchema,
  taskInput,
  sprintSchema,
  userSchema,
  aiJobSchema,
} from '@hub/shared';
import type { Project, Task, TaskStatus } from '@hub/shared';
import {
  Plus,
  Search,
  SlidersHorizontal,
  CalendarDays,
  ArrowUpRight,
  LayoutGrid,
  List,
  Layers,
  Sparkles,
  Clock3,
  Link,
  Check,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { api, post, patch, useSession } from '../core/api';
import { Avatar, Empty, ErrorMessage, Modal, dateLabel } from '../core/components';
import { useProjectRoom } from '../core/realtime';
import { TaskDetail } from './tasks';
import { ProjectMetrics } from './ProjectMetrics';
export function Workspace({ project }: { project: Project }) {
  useProjectRoom(project.id);
  const client = useQueryClient(),
    user = useSession((s) => s.user);
  const manager =
    user?.role === 'ADMIN' || (user?.role === 'LEADER' && project.myRole === 'LEADER');
  const [tab, setTab] = useState<'board' | 'backlog' | 'sprints'>('board'),
    [search, setSearch] = useState(''),
    [mine, setMine] = useState(false),
    [priority, setPriority] = useState(false),
    [newTask, setNewTask] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [sprintDialog, setSprintDialog] = useState(false),
    [summaryOpen, setSummaryOpen] = useState(false),
    [jobId, setJobId] = useState<string | null>(null);
  const tasks = useQuery({
    queryKey: ['tasks', project.id],
    queryFn: () => api(`/projects/${project.id}/tasks`, z.array(taskSchema)),
    refetchInterval: 30000,
  });
  const sprints = useQuery({
    queryKey: ['sprints', project.id],
    queryFn: () => api(`/projects/${project.id}/sprints`, z.array(sprintSchema)),
  });
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api('/users', z.array(userSchema)),
  });
  const active = sprints.data?.find((s) => s.state === 'ACTIVE');
  const [scope, setScope] = useState('active');
  const move = useMutation({
    mutationFn: ({ task, status }: { task: Task; status: TaskStatus }) =>
      api(
        `/projects/${project.id}/tasks/${task.id}`,
        taskSchema,
        patch({ status, version: task.version }),
      ),
    onMutate: async ({ task, status }) => {
      await client.cancelQueries({ queryKey: ['tasks', project.id] });
      const previous = client.getQueryData<Task[]>(['tasks', project.id]);
      client.setQueryData<Task[]>(['tasks', project.id], (old) =>
        old?.map((t) => (t.id === task.id ? { ...t, status } : t)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(['tasks', project.id], context.previous);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['tasks', project.id] });
      void client.invalidateQueries({ queryKey: ['mine'] });
      void client.invalidateQueries({ queryKey: ['heat'] });
    },
  });
  const ai = useMutation({
    mutationFn: () =>
      api(`/projects/${project.id}/ai/summary`, z.object({ id: z.string() }), post({})),
    onSuccess: (data) => setJobId(data.id),
  });
  const job = useQuery({
    queryKey: ['ai', project.id, jobId],
    queryFn: () => api(`/projects/${project.id}/ai/jobs/${jobId}`, aiJobSchema),
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      ['completed', 'failed'].includes(query.state.data?.state ?? '') ? false : 2000,
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const visible = (tasks.data ?? []).filter(
    (t) =>
      t.title.toLowerCase().includes(search.toLowerCase()) &&
      (!mine || t.assigneeId === user?.id) &&
      (!priority || t.priority === 'HIGH') &&
      (tab === 'backlog'
        ? t.sprintId === null
        : scope === 'all' || (active ? t.sprintId === active.id : t.sprintId === null)),
  );
  const boardTasks = visible.filter((t) => t.kind === 'TASK'),
    done = boardTasks.filter((t) => t.status === 'DONE').length,
    points = boardTasks.reduce((sum, t) => sum + t.points, 0);
  const canMove = (task: Task) =>
    !project.archived &&
    !move.isPending &&
    (manager ||
      task.assigneeId === user?.id ||
      (task.assigneeId === null && task.createdBy === user?.id));
  const drop = ({ active: drag, over }: DragEndEvent) => {
    const task = tasks.data?.find((t) => t.id === drag.id),
      status = statusSchema.safeParse(over?.id);
    if (task && status.success && task.status !== status.data && canMove(task))
      move.mutate({ task, status: status.data });
  };
  const selectedTask = tasks.data?.find((t) => t.id === selected);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            WORKSPACE / {project.kind === 'EXTERNAL' ? 'PROJETO EXTERNO' : 'PROJETO INTERNO'}
          </p>
          <h1>
            {project.name}
            <span className="heading-dot" />
          </h1>
          <p className="muted">
            {project.description ||
              'Conecte pessoas, organize entregas e construa o próximo passo.'}
          </p>
        </div>
        <div className="heading-actions">
          {manager && (
            <button className="secondary ai-button" onClick={() => setSummaryOpen(true)}>
              <Sparkles size={16} /> Resumo com IA
            </button>
          )}
          <button className="primary" disabled={project.archived} onClick={() => setNewTask(true)}>
            <Plus size={18} /> Nova tarefa
          </button>
        </div>
      </div>
      {project.archived && (
        <p className="notice">Projeto arquivado · workspace disponível para consulta.</p>
      )}
      <div className="sprint-banner">
        <div className="sprint-symbol">
          <Layers size={25} />
        </div>
        <div className="sprint-info">
          <span className="eyebrow">{active ? 'EM MOVIMENTO' : 'PRÓXIMO PASSO'}</span>
          <h2>
            {active?.name ?? 'Seu próximo ciclo começa aqui'}{' '}
            {active && <span className="status-live">Em andamento</span>}
          </h2>
          <p>{active?.goal ?? 'Organize o backlog e defina um objetivo para o time.'}</p>
        </div>
        <div className="sprint-date">
          <CalendarDays size={16} />
          {active
            ? `${dateLabel(active.startsOn)} — ${dateLabel(active.endsOn)}`
            : 'Nenhuma sprint ativa'}
          <div className="progress">
            <span
              style={{ width: `${boardTasks.length ? (done / boardTasks.length) * 100 : 0}%` }}
            />
          </div>
          <small>
            {done} de {boardTasks.length} tarefas concluídas
          </small>
        </div>
      </div>
      <div className="workspace-tabs">
        <div role="tablist" aria-label="Visão do projeto">
          {(
            [
              { id: 'board', label: 'Kanban', icon: LayoutGrid },
              { id: 'backlog', label: 'Backlog', icon: List },
              { id: 'sprints', label: 'Sprints', icon: Layers },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={16} />
              {item.label}
              {item.id === 'backlog' && (
                <span className="count">
                  {tasks.data?.filter((t) => t.sprintId === null).length ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>
        <span className="quiet">{points} story points na visão</span>
      </div>
      <ErrorMessage error={tasks.error ?? sprints.error ?? move.error} />
      {tasks.isPending && (
        <p role="status" className="muted">
          Carregando workspace…
        </p>
      )}
      {tab === 'sprints' ? (
        <>
          <ProjectMetrics projectId={project.id} />
          <div className="toolbar">
            <p className="muted">Objetivos claros. Entregas com continuidade.</p>
            {manager && (
              <button
                className="secondary"
                disabled={project.archived}
                onClick={() => setSprintDialog(true)}
              >
                <Plus size={16} /> Criar sprint
              </button>
            )}
          </div>
          <div className="sprint-list">
            {sprints.data?.map((sprint) => (
              <SprintRow
                key={sprint.id}
                sprint={sprint}
                manager={Boolean(manager) && !project.archived}
                projectId={project.id}
              />
            ))}
            {sprints.data?.length === 0 && (
              <Empty
                title="Um objetivo compartilhado"
                detail="Crie a primeira sprint e selecione seu escopo no backlog antes de iniciá-la."
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div className="toolbar">
            <label className="search">
              <Search size={17} />
              <input
                aria-label="Buscar tarefas"
                placeholder="Buscar tarefa…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              className={`filter ${mine ? 'selected' : ''}`}
              aria-pressed={mine}
              onClick={() => setMine(!mine)}
            >
              Minhas tarefas
            </button>
            <button
              className={`filter ${priority ? 'selected' : ''}`}
              aria-pressed={priority}
              onClick={() => setPriority(!priority)}
            >
              <SlidersHorizontal size={15} /> Alta prioridade
            </button>
            <div className="toolbar-end">
              {tab === 'board' && (
                <select
                  aria-label="Escopo do quadro"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  <option value="active">{active ? 'Sprint atual' : 'Backlog'}</option>
                  <option value="all">Todas as tarefas</option>
                </select>
              )}
              <span className="quiet">{boardTasks.length} tarefas</span>
            </div>
          </div>
          {tab === 'board' ? (
            <DndContext sensors={sensors} onDragEnd={drop}>
              <div className="kanban">
                {statusSchema.options.map((status) => (
                  <Column
                    key={status}
                    status={status}
                    count={boardTasks.filter((t) => t.status === status).length}
                    onAdd={() => setNewTask(true)}
                    canAdd={!project.archived}
                  >
                    {boardTasks
                      .filter((t) => t.status === status)
                      .map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
                          name={
                            users.data?.find((u) => u.id === task.assigneeId)?.name ??
                            'Sem responsável'
                          }
                          onOpen={() => setSelected(task.id)}
                          draggable={Boolean(canMove(task))}
                        />
                      ))}
                  </Column>
                ))}
              </div>
            </DndContext>
          ) : (
            <div className="backlog">
              {visible.length === 0 && (
                <Empty
                  title="Espaço para o próximo impacto"
                  detail="Crie uma tarefa ou ajuste os filtros para encontrar itens do backlog."
                />
              )}
              {visible.map((task) => (
                <button className="backlog-row" key={task.id} onClick={() => setSelected(task.id)}>
                  <span className={`priority-dot ${task.priority.toLowerCase()}`} />
                  <span className="task-code">
                    {task.kind === 'EPIC' ? 'ÉPICO' : task.id.slice(0, 6).toUpperCase()}
                  </span>
                  <strong>{task.title}</strong>
                  <span className="tag">{task.points} pts</span>
                  <span className="quiet">{dateLabel(task.dueDate)}</span>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </div>
          )}
        </>
      )}
      <CreateTask
        open={newTask}
        onOpenChange={setNewTask}
        projectId={project.id}
        manager={Boolean(manager)}
        userId={user?.id ?? ''}
      />
      {selectedTask && (
        <TaskDetail task={selectedTask} project={project} onClose={() => setSelected(null)} />
      )}
      <CreateSprint open={sprintDialog} onOpenChange={setSprintDialog} projectId={project.id} />
      <Modal
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        title="Um olhar para o próximo passo"
        description="A IA recebe títulos, status, prioridades, pontos e prazos deste projeto. Revise as sugestões antes de agir."
      >
        <button
          className="primary"
          disabled={ai.isPending || (job.isFetching && job.data?.state === 'active')}
          onClick={() => ai.mutate()}
        >
          <Sparkles size={16} />
          Gerar resumo do projeto
        </button>
        <ErrorMessage error={ai.error ?? job.error} />
        {jobId && job.data?.state !== 'completed' && (
          <p role="status" className="muted">
            {job.data?.state === 'failed'
              ? 'Não foi possível gerar o resumo. Tente novamente.'
              : 'Preparando o resumo…'}
          </p>
        )}
        {job.data?.result && (
          <div className="markdown ai-result">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{job.data.result}</ReactMarkdown>
          </div>
        )}
      </Modal>
    </>
  );
}
function Column({
  status,
  count,
  onAdd,
  canAdd,
  children,
}: {
  status: TaskStatus;
  count: number;
  onAdd: () => void;
  canAdd: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section
      ref={setNodeRef}
      className={`kanban-column ${isOver ? 'over' : ''}`}
      aria-label={statusLabels[status]}
    >
      <div className="column-heading">
        <span className={`column-dot ${status.toLowerCase()}`} />
        <h3>{statusLabels[status]}</h3>
        <span className="count">{count}</span>
        <button
          className="icon-button"
          aria-label={`Criar tarefa no backlog`}
          disabled={!canAdd}
          onClick={onAdd}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="column-cards">
        {children}
        {count === 0 && <p className="drop-hint">Espaço para novas entregas</p>}
      </div>
      <button className="add-card" disabled={!canAdd} onClick={onAdd}>
        <Plus size={15} /> Adicionar ao backlog
      </button>
    </section>
  );
}
function TaskCard({
  task,
  name,
  onOpen,
  draggable,
}: {
  task: Task;
  name: string;
  onOpen: () => void;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !draggable,
  });
  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={`task-card ${task.status === 'DONE' ? 'completed' : ''}`}
      {...attributes}
      {...listeners}
    >
      <div className="card-top">
        <span className="task-code">CITIHUB-{task.id.slice(0, 4).toUpperCase()}</span>
        <span className={`priority ${task.priority.toLowerCase()}`}>
          {task.priority === 'HIGH' ? '↑ Alta' : task.priority === 'MEDIUM' ? '— Média' : '↓ Baixa'}
        </span>
      </div>
      <button className="card-title" onClick={onOpen}>
        {task.title}
      </button>
      <div className="card-tags">
        {task.tags.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <div className="card-meta">
        <span>
          <Clock3 size={13} />
          {dateLabel(task.dueDate)}
        </span>
        {task.checklist.length > 0 && (
          <span>
            <Check size={13} />
            {task.checklist.filter((i) => i.done).length}/{task.checklist.length}
          </span>
        )}
        {task.links.length > 0 && <Link size={13} />}
      </div>
      <div className="card-footer">
        <Avatar name={name} small />
        <span className="assignee-name">{name.split(' ')[0]}</span>
        <span className="points">
          {task.points} <small>pts</small>
        </span>
      </div>
    </article>
  );
}
function CreateTask({
  open,
  onOpenChange,
  projectId,
  manager,
  userId,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  projectId: string;
  manager: boolean;
  userId: string;
}) {
  const client = useQueryClient();
  const allocations = useQuery({
    queryKey: ['allocations', projectId],
    queryFn: () =>
      api(
        `/projects/${projectId}/allocations`,
        z.array(z.object({ userId: z.string(), name: z.string() })),
      ),
    enabled: open,
  });
  const mutation = useMutation({
    mutationFn: (input: unknown) =>
      api(`/projects/${projectId}/tasks`, taskSchema, post(taskInput.parse(input))),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks', projectId] });
      void client.invalidateQueries({ queryKey: ['mine'] });
      onOpenChange(false);
    },
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Uma ideia, um próximo passo"
      description="Novos itens entram no backlog. A liderança organiza o escopo das sprints."
    >
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          mutation.mutate({
            title: f.get('title'),
            description: f.get('description'),
            assigneeId: manager ? f.get('assignee') || null : userId,
            points: Number(f.get('points')),
            priority: f.get('priority'),
            kind: f.get('kind') ?? 'TASK',
            dueDate: f.get('dueDate') || null,
            tags: String(f.get('tags'))
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean),
          });
        }}
      >
        <label className="full">
          Título
          <input
            name="title"
            minLength={3}
            maxLength={180}
            required
            placeholder="Qual entrega vamos construir?"
          />
        </label>
        <label className="full">
          Contexto <span className="quiet">Markdown</span>
          <textarea name="description" rows={3} />
        </label>
        <label>
          Tipo
          <select name="kind" disabled={!manager}>
            <option value="TASK">Tarefa</option>
            <option value="EPIC">Épico</option>
          </select>
        </label>
        <label>
          Story points
          <select name="points">
            {[1, 2, 3, 5, 8].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Prioridade
          <select name="priority" defaultValue="MEDIUM">
            <option value="HIGH">Alta</option>
            <option value="MEDIUM">Média</option>
            <option value="LOW">Baixa</option>
          </select>
        </label>
        <label>
          Prazo
          <input type="date" name="dueDate" />
        </label>
        {manager && (
          <label className="full">
            Responsável
            <select name="assignee">
              <option value="">Sem responsável</option>
              {allocations.data?.map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="full">
          Especialidades <span className="quiet">separadas por vírgula</span>
          <input name="tags" placeholder="Dev, Design/UX…" />
        </label>
        <ErrorMessage error={mutation.error} />
        <button className="primary full" disabled={mutation.isPending}>
          Criar no backlog <ArrowUpRight size={17} />
        </button>
      </form>
    </Modal>
  );
}
function CreateSprint({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: unknown) => api(`/projects/${projectId}/sprints`, sprintSchema, post(body)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sprints', projectId] });
      onOpenChange(false);
    },
  });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Um novo ciclo">
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate(Object.fromEntries(new FormData(e.currentTarget)));
        }}
      >
        <label className="full">
          Nome
          <input name="name" minLength={3} required />
        </label>
        <label className="full">
          Objetivo
          <textarea name="goal" minLength={3} required />
        </label>
        <label>
          Início
          <input type="date" name="startsOn" required />
        </label>
        <label>
          Fim
          <input type="date" name="endsOn" required />
        </label>
        <ErrorMessage error={mutation.error} />
        <button className="primary full" disabled={mutation.isPending}>
          Criar sprint
        </button>
      </form>
    </Modal>
  );
}
function SprintRow({
  sprint,
  manager,
  projectId,
}: {
  sprint: z.infer<typeof sprintSchema>;
  manager: boolean;
  projectId: string;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (state: 'ACTIVE' | 'CLOSED') =>
      api(`/projects/${projectId}/sprints/${sprint.id}`, sprintSchema, patch({ state })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['sprints', projectId] });
    },
  });
  return (
    <article className="sprint-row">
      <div>
        <span className="eyebrow">
          {sprint.state === 'PLANNED'
            ? 'PLANEJADA'
            : sprint.state === 'ACTIVE'
              ? 'EM ANDAMENTO'
              : 'ENCERRADA'}
        </span>
        <h3>{sprint.name}</h3>
        <p className="muted">{sprint.goal}</p>
        <small>
          {dateLabel(sprint.startsOn)} — {dateLabel(sprint.endsOn)}
        </small>
      </div>
      {manager && sprint.state !== 'CLOSED' && (
        <button
          className="secondary"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(sprint.state === 'PLANNED' ? 'ACTIVE' : 'CLOSED')}
        >
          {sprint.state === 'PLANNED' ? 'Iniciar e fechar escopo' : 'Encerrar sprint'}
        </button>
      )}
      <ErrorMessage error={mutation.error} />
    </article>
  );
}
