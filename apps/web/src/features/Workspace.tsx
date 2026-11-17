import { useId, useState } from 'react';
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
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
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
  closeSprintSchema,
} from '@hub/shared';
import type { CloseSprintInput, Project, Sprint, Task, TaskStatus } from '@hub/shared';
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
  GripVertical,
  ArrowDownToLine,
  ChevronUp,
  ChevronDown,
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
    [pullCount, setPullCount] = useState(3),
    [targetSprintId, setTargetSprintId] = useState(''),
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
  const reorderBacklog = useMutation({
    mutationFn: (orderedTaskIds: string[]) =>
      api(
        `/projects/${project.id}/backlog/reorder`,
        z.object({ ok: z.boolean(), orderedTaskIds: z.array(z.string().uuid()) }),
        patch({ orderedTaskIds }),
      ),
    onMutate: async (orderedTaskIds) => {
      await client.cancelQueries({ queryKey: ['tasks', project.id] });
      const previous = client.getQueryData<Task[]>(['tasks', project.id]);
      client.setQueryData<Task[]>(['tasks', project.id], (old) => {
        if (!old) return old;
        const rank = new Map(orderedTaskIds.map((taskId, index) => [taskId, index]));
        return old.map((task) =>
          task.sprintId === null && rank.has(task.id)
            ? { ...task, backlogPosition: rank.get(task.id) ?? task.backlogPosition }
            : task,
        );
      });
      return { previous };
    },
    onError: (_error, _orderedTaskIds, context) => {
      if (context?.previous) client.setQueryData(['tasks', project.id], context.previous);
    },
    onSettled: () => void client.invalidateQueries({ queryKey: ['tasks', project.id] }),
  });
  const pullToSprint = useMutation({
    mutationFn: ({ taskIds, sprintId }: { taskIds: string[]; sprintId: string }) =>
      api(
        `/projects/${project.id}/backlog/pull-to-sprint`,
        z.object({ ok: z.boolean(), movedCount: z.number(), targetSprintId: z.string().uuid() }),
        post({ taskIds, targetSprintId: sprintId }),
      ),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['tasks', project.id] });
      void client.invalidateQueries({ queryKey: ['sprints', project.id] });
      void client.invalidateQueries({ queryKey: ['metrics', project.id] });
      void client.invalidateQueries({ queryKey: ['activity', project.id] });
      void client.invalidateQueries({ queryKey: ['mine'] });
      setTargetSprintId(result.targetSprintId);
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
  const backlogSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
  const backlog = (tasks.data ?? [])
    .filter((task) => task.sprintId === null)
    .sort(
      (a, b) => a.backlogPosition - b.backlogPosition || a.createdAt.localeCompare(b.createdAt),
    );
  const visibleBacklog = visible.filter((task) => task.sprintId === null);
  const plannedSprints = (sprints.data ?? []).filter((sprint) => sprint.state === 'PLANNED');
  const canPrioritize = Boolean(manager) && !project.archived && !search && !mine && !priority;
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
      <ErrorMessage
        error={
          tasks.error ?? sprints.error ?? move.error ?? reorderBacklog.error ?? pullToSprint.error
        }
      />
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
            <>
              <div className="backlog-tools">
                <div>
                  <strong>Prioridade do backlog</strong>
                  <span className="quiet">
                    {canPrioritize
                      ? 'Arraste pelo controle ou use os botões para alterar a ordem.'
                      : manager
                        ? 'Limpe os filtros para reordenar as tarefas.'
                        : 'A ordem é gerenciada pela liderança do projeto.'}
                  </span>
                </div>
                <div className="backlog-pull-controls">
                  <label>
                    Sprint planejada
                    <select
                      value={targetSprintId}
                      onChange={(event) => setTargetSprintId(event.target.value)}
                      disabled={!plannedSprints.length || !manager || project.archived}
                    >
                      <option value="">Selecionar sprint</option>
                      {plannedSprints.map((sprint) => (
                        <option key={sprint.id} value={sprint.id}>
                          {sprint.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="backlog-count">
                    Itens
                    <input
                      type="number"
                      min={1}
                      max={Math.max(1, backlog.length)}
                      value={pullCount}
                      onChange={(event) =>
                        setPullCount(Math.max(1, Number(event.target.value) || 1))
                      }
                      disabled={!backlog.length}
                    />
                  </label>
                  <button
                    className="secondary backlog-pull-button"
                    disabled={
                      !manager ||
                      project.archived ||
                      !targetSprintId ||
                      !backlog.length ||
                      pullToSprint.isPending
                    }
                    onClick={() =>
                      pullToSprint.mutate({
                        taskIds: backlog.slice(0, pullCount).map((task) => task.id),
                        sprintId: targetSprintId,
                      })
                    }
                  >
                    <ArrowDownToLine size={15} /> Puxar top {Math.min(pullCount, backlog.length)}
                  </button>
                </div>
                {!plannedSprints.length && (
                  <span className="quiet backlog-note">
                    Crie uma sprint planejada para puxar itens do backlog.
                  </span>
                )}
              </div>
              {pullToSprint.isSuccess && (
                <p role="status" className="backlog-success">
                  Tarefas adicionadas à sprint planejada.
                </p>
              )}
              <div className="backlog">
                {visibleBacklog.length === 0 && (
                  <Empty
                    title="Backlog vazio"
                    detail="Crie uma tarefa ou ajuste os filtros para encontrar itens."
                  />
                )}
                <DndContext
                  sensors={backlogSensors}
                  onDragEnd={({ active: dragged, over }) => {
                    if (!over || dragged.id === over.id || !canPrioritize) return;
                    const oldIndex = backlog.findIndex((task) => task.id === dragged.id);
                    const newIndex = backlog.findIndex((task) => task.id === over.id);
                    if (oldIndex < 0 || newIndex < 0) return;
                    reorderBacklog.mutate(
                      arrayMove(backlog, oldIndex, newIndex).map((task) => task.id),
                    );
                  }}
                >
                  <SortableContext
                    items={visibleBacklog.map((task) => task.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {visibleBacklog.map((task) => (
                      <SortableBacklogRow
                        key={task.id}
                        task={task}
                        rank={backlog.findIndex((item) => item.id === task.id) + 1}
                        total={backlog.length}
                        disabled={!canPrioritize || reorderBacklog.isPending}
                        onOpen={() => setSelected(task.id)}
                        onMove={(direction) => {
                          const index = backlog.findIndex((item) => item.id === task.id);
                          const nextIndex = index + direction;
                          if (index >= 0 && nextIndex >= 0 && nextIndex < backlog.length)
                            reorderBacklog.mutate(
                              arrayMove(backlog, index, nextIndex).map((item) => item.id),
                            );
                        }}
                        onMoveToTop={() => {
                          if (backlog[0]?.id !== task.id)
                            reorderBacklog.mutate([
                              task.id,
                              ...backlog
                                .filter((item) => item.id !== task.id)
                                .map((item) => item.id),
                            ]);
                        }}
                        onSend={() => {
                          if (targetSprintId)
                            pullToSprint.mutate({ taskIds: [task.id], sprintId: targetSprintId });
                        }}
                        canSend={
                          Boolean(manager) &&
                          !project.archived &&
                          Boolean(targetSprintId) &&
                          !pullToSprint.isPending
                        }
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </div>
            </>
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
function SortableBacklogRow({
  task,
  rank,
  total,
  disabled,
  onOpen,
  onMove,
  onMoveToTop,
  onSend,
  canSend,
}: {
  task: Task;
  rank: number;
  total: number;
  disabled: boolean;
  onOpen: () => void;
  onMove: (direction: -1 | 1) => void;
  onMoveToTop: () => void;
  onSend: () => void;
  canSend: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  return (
    <article
      ref={setNodeRef}
      className={`backlog-row ${isDragging ? 'is-dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <span className="backlog-rank" aria-label={`Prioridade ${rank}`}>
        {rank}
      </span>
      <button
        className="backlog-drag-handle"
        type="button"
        aria-label={`Reordenar ${task.title}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <span className={`priority-dot ${task.priority.toLowerCase()}`} />
      <span className="task-code">
        {task.kind === 'EPIC' ? 'ÉPICO' : task.id.slice(0, 6).toUpperCase()}
      </span>
      <button className="backlog-task-open" type="button" onClick={onOpen}>
        <strong>{task.title}</strong>
      </button>
      <span className="tag">{task.points} pts</span>
      <span className="quiet">{dateLabel(task.dueDate)}</span>
      <button
        className="backlog-send-button"
        type="button"
        disabled={!canSend}
        aria-label={`Enviar ${task.title} para a sprint selecionada`}
        onClick={onSend}
      >
        Enviar
      </button>
      <div className="backlog-order-actions" aria-label={`Ações de prioridade para ${task.title}`}>
        <button
          type="button"
          aria-label={`Mover ${task.title} para cima`}
          disabled={disabled || rank === 1}
          onClick={() => onMove(-1)}
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          aria-label={`Mover ${task.title} para baixo`}
          disabled={disabled || rank === total}
          onClick={() => onMove(1)}
        >
          <ChevronDown size={15} />
        </button>
        <button
          type="button"
          aria-label={`Mover ${task.title} para o topo`}
          disabled={disabled || rank === 1}
          onClick={onMoveToTop}
        >
          <ArrowUpRight size={15} />
        </button>
      </div>
    </article>
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
  sprint: Sprint;
  manager: boolean;
  projectId: string;
}) {
  const client = useQueryClient();
  const [closing, setClosing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/sprints/${sprint.id}`, sprintSchema, patch({ state: 'ACTIVE' })),
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
        {feedback && (
          <p role="status" className="sprint-close-feedback">
            {feedback}
          </p>
        )}
      </div>
      {manager && sprint.state !== 'CLOSED' && (
        <button
          className="secondary"
          disabled={mutation.isPending}
          onClick={() => {
            if (sprint.state === 'PLANNED') mutation.mutate();
            else {
              setFeedback('');
              setClosing(true);
            }
          }}
        >
          {sprint.state === 'PLANNED' ? 'Iniciar e fechar escopo' : 'Encerrar sprint'}
        </button>
      )}
      <ErrorMessage error={mutation.error} />
      {closing && (
        <CloseSprintDialog
          sprint={sprint}
          projectId={projectId}
          onClose={() => setClosing(false)}
          onClosed={(destination) => {
            setClosing(false);
            setFeedback(`Sprint encerrada. Pendências enviadas para ${destination}.`);
          }}
        />
      )}
    </article>
  );
}

function CloseSprintDialog({
  sprint,
  projectId,
  onClose,
  onClosed,
}: {
  sprint: Sprint;
  projectId: string;
  onClose: () => void;
  onClosed: (destination: string) => void;
}) {
  const client = useQueryClient();
  const fieldId = useId();
  const [action, setAction] = useState<CloseSprintInput['unfinishedAction']>('BACKLOG');
  const [targetId, setTargetId] = useState('');
  const tasks = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api(`/projects/${projectId}/tasks`, z.array(taskSchema)),
    refetchOnMount: 'always',
  });
  const sprints = useQuery({
    queryKey: ['sprints', projectId],
    queryFn: () => api(`/projects/${projectId}/sprints`, z.array(sprintSchema)),
    refetchOnMount: 'always',
  });
  const scope = (tasks.data ?? []).filter((task) => task.sprintId === sprint.id);
  const work = scope.filter((task) => task.kind === 'TASK');
  const done = work.filter((task) => task.status === 'DONE');
  const pending = work.filter((task) => task.status !== 'DONE');
  const hasPending = scope.some((task) => task.status !== 'DONE');
  const planned = (sprints.data ?? []).filter(
    (item) => item.state === 'PLANNED' && item.id !== sprint.id,
  );
  const target = planned.find((item) => item.id === targetId) ?? planned[0];
  const loaded = tasks.isSuccess && sprints.isSuccess;
  const refreshing = tasks.isFetching || sprints.isFetching;
  const active = sprints.data?.find((item) => item.id === sprint.id)?.state === 'ACTIVE';
  const mutation = useMutation({
    mutationFn: (input: CloseSprintInput) =>
      api(
        `/projects/${projectId}/sprints/${sprint.id}`,
        sprintSchema,
        patch({ state: 'CLOSED', ...closeSprintSchema.parse(input) }),
      ),
    onSuccess: async (_result, input) => {
      await Promise.all(
        [
          ['sprints', projectId],
          ['tasks', projectId],
          ['metrics', projectId],
          ['activity', projectId],
          ['mine'],
          ['heat'],
        ].map((queryKey) => client.invalidateQueries({ queryKey })),
      );
      onClosed(
        input.unfinishedAction === 'BACKLOG'
          ? 'o backlog'
          : `a sprint ${target?.name ?? 'planejada'}`,
      );
    },
  });
  const busy = refreshing || mutation.isPending;
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
      title="Encerrar sprint"
      description={`${sprint.name}: tarefas concluídas ficam nesta sprint. Itens pendentes mantêm seu status no destino escolhido.`}
    >
      <form
        className="sprint-close-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          if (!loaded || busy || !active || (hasPending && action === 'NEXT_SPRINT' && !target))
            return;
          mutation.mutate(
            hasPending && action === 'NEXT_SPRINT'
              ? { unfinishedAction: 'NEXT_SPRINT', targetSprintId: target?.id }
              : { unfinishedAction: 'BACKLOG' },
          );
        }}
      >
        {!loaded ? (
          <p role="status" className="muted">
            Atualizando dados da sprint…
          </p>
        ) : (
          <>
            {refreshing && (
              <p role="status" className="muted">
                Atualizando dados da sprint…
              </p>
            )}
            <dl className="sprint-close-summary">
              <div>
                <dt>Concluídas</dt>
                <dd>
                  {done.length} tarefas · {done.reduce((sum, task) => sum + task.points, 0)} pts
                </dd>
              </div>
              <div>
                <dt>Pendentes</dt>
                <dd>
                  {pending.length} tarefas · {pending.reduce((sum, task) => sum + task.points, 0)}{' '}
                  pts
                </dd>
              </div>
            </dl>
            {scope.some((task) => task.kind === 'EPIC' && task.status !== 'DONE') && (
              <p className="muted">
                Épicos pendentes também serão movidos. Os totais acima contabilizam apenas tarefas.
              </p>
            )}
            {!active && (
              <p role="alert" className="error">
                Esta sprint não está mais ativa. Feche este modal para consultar o estado atual.
              </p>
            )}
            {hasPending ? (
              <fieldset className="carryover-choices" disabled={busy || !active}>
                <legend>Destino dos itens pendentes</legend>
                <label className="carryover-option">
                  <input
                    type="radio"
                    name={fieldId}
                    value="BACKLOG"
                    checked={action === 'BACKLOG'}
                    onChange={() => setAction('BACKLOG')}
                  />
                  <span>Devolver ao Backlog</span>
                </label>
                <label className="carryover-option">
                  <input
                    type="radio"
                    name={fieldId}
                    value="NEXT_SPRINT"
                    checked={action === 'NEXT_SPRINT'}
                    disabled={!planned.length}
                    aria-describedby={!planned.length ? `${fieldId}-note` : undefined}
                    onChange={() => setAction('NEXT_SPRINT')}
                  />
                  <span>Mover para próxima Sprint Planejada</span>
                </label>
                {!planned.length && (
                  <p id={`${fieldId}-note`} className="muted">
                    Crie uma sprint planejada antes ou devolva os itens ao backlog.
                  </p>
                )}
                {action === 'NEXT_SPRINT' && planned.length > 0 && (
                  <label htmlFor={`${fieldId}-target`}>
                    Sprint de destino
                    <select
                      id={`${fieldId}-target`}
                      required
                      value={target?.id ?? ''}
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      {planned.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>
            ) : (
              <p className="muted">Nenhum item pendente. A sprint pode ser encerrada.</p>
            )}
          </>
        )}
        <ErrorMessage error={tasks.error ?? sprints.error ?? mutation.error} />
        {(tasks.isError || sprints.isError) && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void tasks.refetch();
              void sprints.refetch();
            }}
          >
            Tentar novamente
          </button>
        )}
        <div className="sprint-close-actions">
          <button
            type="button"
            className="secondary"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              !loaded || busy || !active || (hasPending && action === 'NEXT_SPRINT' && !target)
            }
          >
            {mutation.isPending ? 'Encerrando…' : 'Confirmar encerramento'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
