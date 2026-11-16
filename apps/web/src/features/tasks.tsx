import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { taskSchema, statusSchema, statusLabels, sprintSchema, commentSchema } from '@hub/shared';
import type { Task, Project } from '@hub/shared';
import { Plus, ExternalLink, Send } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { api, patch, post, ok, useSession } from '../core/api';
import { ErrorMessage, Modal, Avatar, dateLabel } from '../core/components';
export function TaskDetail({
  task,
  project,
  onClose,
}: {
  task: Task;
  project: Project;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    user = useSession((s) => s.user),
    manager = user?.role === 'ADMIN' || (user?.role === 'LEADER' && project.myRole === 'LEADER');
  const own =
    task.assigneeId === user?.id || (task.assigneeId === null && task.createdBy === user?.id);

  const [editing, setEditing] = useState(false),
    [checkTitle, setCheckTitle] = useState('');
  const sprints = useQuery({
    queryKey: ['sprints', project.id],
    queryFn: () => api(`/projects/${project.id}/sprints`, z.array(sprintSchema)),
  });
  const closed = sprints.data?.some((s) => s.id === task.sprintId && s.state === 'CLOSED') ?? false;
  const editable = !project.archived && !closed && (manager || own);
  const epics = (client.getQueryData<Task[]>(['tasks', project.id]) ?? []).filter(
    (t) => t.kind === 'EPIC' && t.id !== task.id,
  );
  const allocations = useQuery({
    queryKey: ['allocations', project.id],
    queryFn: () =>
      api(
        `/projects/${project.id}/allocations`,
        z.array(z.object({ userId: z.string(), name: z.string() })),
      ),
  });
  const comments = useQuery({
    queryKey: ['comments', task.id],
    queryFn: () => api(`/projects/${project.id}/tasks/${task.id}/comments`, z.array(commentSchema)),
    refetchInterval: 15000,
  });
  const update = useMutation({
    mutationFn: (changes: unknown) =>
      api(
        `/projects/${project.id}/tasks/${task.id}`,
        taskSchema,
        patch({ ...(changes as Record<string, unknown>), version: task.version }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks', project.id] });
      void client.invalidateQueries({ queryKey: ['mine'] });
      setEditing(false);
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: ['tasks', project.id] });
    },
  });
  const comment = useMutation({
    mutationFn: (body: string) =>
      api(`/projects/${project.id}/tasks/${task.id}/comments`, ok, post({ body })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['comments', task.id] });
    },
  });
  return (
    <Modal
      title={task.title}
      description={`${task.kind === 'EPIC' ? 'Épico' : 'Tarefa'} • CITIHUB-${task.id.slice(0, 4).toUpperCase()} • ${dateLabel(task.dueDate)}`}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="task-properties">
        <label>
          Status
          <select
            value={task.status}
            disabled={!editable || update.isPending}
            onChange={(e) => update.mutate({ status: e.target.value })}
          >
            {statusSchema.options.map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Responsável
          <select
            value={task.assigneeId ?? ''}
            disabled={!manager || !editable || update.isPending}
            onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}
          >
            <option value="">Sem responsável</option>
            {allocations.data?.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {manager && (
          <label>
            Sprint
            <select
              value={task.sprintId ?? ''}
              disabled={!editable || update.isPending}
              onChange={(e) => update.mutate({ sprintId: e.target.value || null })}
            >
              <option value="">Backlog</option>
              {sprints.data?.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name} ·{' '}
                  {s.state === 'PLANNED'
                    ? 'Planejada'
                    : s.state === 'ACTIVE'
                      ? 'Ativa'
                      : 'Encerrada'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Story points
          <select
            value={task.points}
            disabled={!manager || !editable || update.isPending}
            onChange={(e) => update.mutate({ points: Number(e.target.value) })}
          >
            {[1, 2, 3, 5, 8].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>
      <ErrorMessage error={update.error} />
      <div className="detail-section">
        <div className="section-label">
          <h3>Contexto e critérios de aceite</h3>
          {editable && (
            <button className="text-button" onClick={() => setEditing(!editing)}>
              {editing ? 'Cancelar' : 'Editar'}
            </button>
          )}
        </div>
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              update.mutate({
                description: data.get('description'),
                acceptance: data.get('acceptance'),
                ...(manager
                  ? {
                      title: data.get('title'),
                      priority: data.get('priority'),
                      dueDate: data.get('dueDate') || null,
                      epicId: data.get('epicId') || null,
                      tags: String(data.get('tags'))
                        .split(',')
                        .map((t) => t.trim())
                        .filter(Boolean),
                    }
                  : {}),
              });
            }}
          >
            {manager && (
              <>
                <label>
                  Título
                  <input
                    name="title"
                    defaultValue={task.title}
                    minLength={3}
                    maxLength={180}
                    required
                  />
                </label>
                <div className="form-grid">
                  <label>
                    Prioridade
                    <select name="priority" defaultValue={task.priority}>
                      <option value="HIGH">Alta</option>
                      <option value="MEDIUM">Média</option>
                      <option value="LOW">Baixa</option>
                    </select>
                  </label>
                  <label>
                    Prazo
                    <input name="dueDate" type="date" defaultValue={task.dueDate ?? ''} />
                  </label>
                </div>
                <label>
                  Épico
                  <select
                    name="epicId"
                    defaultValue={task.epicId ?? ''}
                    disabled={task.kind === 'EPIC'}
                  >
                    <option value="">Sem épico</option>
                    {epics.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Especialidades (separadas por vírgula)
                  <input name="tags" defaultValue={task.tags.join(', ')} />
                </label>
              </>
            )}
            <label>
              Descrição em Markdown
              <textarea name="description" rows={5} defaultValue={task.description} />
            </label>
            <label>
              Critérios de aceite
              <textarea name="acceptance" rows={3} defaultValue={task.acceptance} />
            </label>
            <button className="secondary" disabled={update.isPending}>
              Salvar contexto
            </button>
          </form>
        ) : (
          <div className="markdown">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>
              {task.description ||
                'Ainda sem contexto. Registre as decisões para o próximo handoff.'}
            </ReactMarkdown>
            {task.acceptance && (
              <>
                <h4>Critérios de aceite</h4>
                <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{task.acceptance}</ReactMarkdown>
              </>
            )}
          </div>
        )}
      </div>
      <div className="detail-section">
        <h3>
          Checklist{' '}
          <span className="quiet">
            {task.checklist.filter((c) => c.done).length}/{task.checklist.length}
          </span>
        </h3>
        {task.checklist.map((item) => (
          <label className="checklist-item" key={item.id}>
            <input
              type="checkbox"
              checked={item.done}
              disabled={!editable || update.isPending}
              onChange={() =>
                update.mutate({
                  checklist: task.checklist.map((c) =>
                    c.id === item.id ? { ...c, done: !c.done } : c,
                  ),
                })
              }
            />
            {item.title}
          </label>
        ))}
        {editable && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({
                checklist: [
                  ...task.checklist,
                  { id: crypto.randomUUID(), title: checkTitle, done: false },
                ],
              });
              setCheckTitle('');
            }}
          >
            <input
              value={checkTitle}
              onChange={(e) => setCheckTitle(e.target.value)}
              maxLength={250}
              aria-label="Nova subtarefa"
              placeholder="Adicionar subtarefa"
              required
            />
            <button
              className="icon-button"
              aria-label="Adicionar subtarefa"
              disabled={update.isPending}
            >
              <Plus size={18} />
            </button>
          </form>
        )}
      </div>
      <div className="detail-section">
        <h3>Links e referências</h3>
        {task.links.map((link) => (
          <a className="external-link" key={link} href={link} target="_blank" rel="noreferrer">
            {link}
            <ExternalLink size={14} />
          </a>
        ))}
        {editable && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              update.mutate({ links: [...task.links, String(new FormData(form).get('link'))] });
              form.reset();
            }}
          >
            <input
              name="link"
              type="url"
              pattern="https://.*"
              aria-label="Novo link HTTPS"
              placeholder="https://figma.com/…"
              required
            />
            <button className="icon-button" aria-label="Adicionar link" disabled={update.isPending}>
              <Plus size={18} />
            </button>
          </form>
        )}
      </div>
      <div className="detail-section">
        <h3>Conversa com contexto</h3>
        <ErrorMessage error={comments.error ?? comment.error} />
        {comments.data?.map((c) => (
          <article className="comment" key={c.id}>
            <Avatar name={c.author} small />
            <div>
              <strong>{c.author}</strong>
              <div className="markdown">
                <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{c.body}</ReactMarkdown>
              </div>
            </div>
          </article>
        ))}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            comment.mutate(String(new FormData(form).get('body')), {
              onSuccess: () => form.reset(),
            });
          }}
        >
          <input
            name="body"
            aria-label="Comentário"
            placeholder="Compartilhe uma decisão ou atualização…"
            maxLength={5000}
            required
          />
          <button
            className="icon-button"
            aria-label="Enviar comentário"
            disabled={comment.isPending || project.archived}
          >
            <Send size={18} />
          </button>
        </form>
      </div>
    </Modal>
  );
}
