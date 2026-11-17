import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  knowledgeDocumentSchema,
  knowledgeCategorySchema,
  knowledgeQueryResponseSchema,
  projectSchema,
} from '@hub/shared';
import type { KnowledgeQueryResponse } from '@hub/shared';
import { api, ok, post, useSession } from '../../core/api';
import { ErrorMessage, Modal } from '../../core/components';

export function Knowledge({ projectId }: { projectId?: string }) {
  const user = useSession((s) => s.user);
  const client = useQueryClient();
  const [scope, setScope] = useState(projectId ?? '');
  const [question, setQuestion] = useState('');
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<{ question: string; result: KnowledgeQueryResponse }[]>(
    [],
  );
  const projects = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: () => api('/projects', z.array(projectSchema)),
  });
  const documents = useQuery({
    queryKey: ['knowledge', scope],
    queryFn: () =>
      api(
        `/knowledge/documents${scope ? `?projectId=${encodeURIComponent(scope)}` : ''}`,
        z.array(knowledgeDocumentSchema),
      ),
    refetchInterval: 10000,
  });
  const invalidate = () => client.invalidateQueries({ queryKey: ['knowledge'] });
  const query = useMutation({
    mutationFn: (text: string) =>
      api(
        '/knowledge/query',
        knowledgeQueryResponseSchema,
        post({ question: text, projectId: scope || null }),
      ),
    onSuccess: (result, text) => {
      setHistory((old) => [{ question: text, result }, ...old]);
      setQuestion('');
    },
  });
  const create = useMutation({
    mutationFn: (body: unknown) => api('/knowledge/documents', knowledgeDocumentSchema, post(body)),
    onSuccess: () => {
      void invalidate();
      setOpen(false);
    },
  });
  const change = useMutation({
    mutationFn: ({ id, remove }: { id: string; remove: boolean }) =>
      api(
        `/knowledge/documents/${id}${remove ? '' : '/reindex'}`,
        ok,
        remove ? { method: 'DELETE' } : post({}),
      ),
    onSuccess: () => void invalidate(),
  });
  return (
    <section className="knowledge">
      <div className="page-heading">
        <h1>Memória Institucional</h1>
      </div>
      <label className="knowledge-scope">
        Escopo
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">Toda a EJ (Acessível)</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="knowledge-grid">
        <div className="knowledge-panel">
          <h2>Consulta</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              query.mutate(question);
            }}
          >
            <label>
              Pergunta
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                minLength={3}
                maxLength={2000}
                required
              />
            </label>
            <button className="primary" disabled={query.isPending}>
              {query.isPending ? 'Consultando…' : 'Consultar'}
            </button>
          </form>
          <ErrorMessage error={query.error} />
          {history.map((entry, index) => (
            <article className="knowledge-answer" key={`${entry.question}-${index}`}>
              <h3>{entry.question}</h3>
              <span className="tag">{entry.result.mode === 'LLM' ? 'LLM' : 'Extrativo Local'}</span>
              <p className="knowledge-text">{entry.result.answer}</p>
              <h3>Fontes citadas</h3>
              {entry.result.citations.map((citation, i) => (
                <a
                  className="knowledge-citation"
                  key={`${citation.documentId}-${i}`}
                  href={`#knowledge-${citation.documentId}`}
                >
                  <strong>{citation.documentTitle}</strong>
                  <span>
                    {citation.category} · {citation.projectName ?? 'Global EJ'} ·{' '}
                    {Math.round(citation.score * 100)}%
                  </span>
                  <p>{citation.snippet}</p>
                </a>
              ))}
            </article>
          ))}
        </div>
        <aside className="knowledge-panel">
          <div className="knowledge-heading">
            <h2>Documentos</h2>
            <button className="secondary" onClick={() => setOpen(true)}>
              + Novo Documento
            </button>
          </div>
          <ErrorMessage error={documents.error ?? change.error} />
          {documents.isPending && <p role="status">Carregando documentos…</p>}
          {documents.data?.length === 0 && <p className="muted">Nenhum documento neste escopo.</p>}
          {documents.data?.map((doc) => {
            const project = projects.data?.find((p) => p.id === doc.projectId);
            const canManage =
              user?.role === 'ADMIN' ||
              doc.createdBy === user?.id ||
              (user?.role === 'LEADER' && project?.myRole === 'LEADER');
            return (
              <article className="knowledge-document" id={`knowledge-${doc.id}`} key={doc.id}>
                <strong>{doc.title}</strong>
                <span>
                  {doc.category} · {project?.name ?? (doc.projectId ? 'Projeto' : 'Global EJ')}
                </span>
                <span className="tag">
                  {doc.status === 'INDEXED'
                    ? 'Indexado'
                    : doc.status === 'FAILED'
                      ? 'Erro'
                      : 'Processando'}
                </span>
                {doc.status === 'FAILED' && doc.errorMessage && <p>{doc.errorMessage}</p>}
                {canManage && (
                  <div className="knowledge-actions">
                    <button
                      className="secondary"
                      disabled={change.isPending}
                      onClick={() => change.mutate({ id: doc.id, remove: false })}
                    >
                      Reindexar
                    </button>
                    <button
                      className="secondary"
                      disabled={change.isPending}
                      onClick={() => {
                        if (window.confirm(`Excluir ${doc.title}?`))
                          change.mutate({ id: doc.id, remove: true });
                      }}
                    >
                      Excluir
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </aside>
      </div>
      <Modal open={open} onOpenChange={setOpen} title="Novo Documento">
        <form
          className="knowledge-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            create.mutate({
              title: form.get('title'),
              category: form.get('category'),
              projectId: form.get('projectId') || null,
              content: form.get('content'),
            });
          }}
        >
          <label>
            Título
            <input name="title" minLength={3} maxLength={180} required />
          </label>
          <label>
            Categoria
            <select name="category">
              {knowledgeCategorySchema.options.map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </label>
          <label>
            Escopo
            <select name="projectId" defaultValue={scope}>
              {user?.role !== 'MEMBER' && <option value="">Global EJ</option>}
              {projects.data
                ?.filter((p) => !p.archived)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Conteúdo
            <textarea name="content" minLength={20} maxLength={80000} required rows={8} />
          </label>
          <ErrorMessage error={create.error} />
          <button className="primary" disabled={create.isPending}>
            Salvar documento
          </button>
        </form>
      </Modal>
    </section>
  );
}
