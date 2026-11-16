import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { bulkProvisionMembersSchema, orgTaxonomySchema, roleSchema, userSchema } from '@hub/shared';
import type { Project, User } from '@hub/shared';
import { Plus, Settings2, Upload } from 'lucide-react';
import { api, patch, post, ok, useSession } from '../core/api';
import { Avatar, ErrorMessage, Modal } from '../core/components';

const bulkResultSchema = z.object({
  created: z.array(z.string()),
  existing: z.array(z.string()),
  createdCount: z.number(),
  existingCount: z.number(),
});
const emptySchema = z.unknown();

function TaxonomyEditor({
  initialName,
  initialSlug,
  initialDescription,
  onSave,
}: {
  initialName: string;
  initialSlug: string;
  initialDescription?: string;
  onSave: (input: { name: string; slug: string; description?: string }) => void;
}) {
  return (
    <details className="org-editor">
      <summary>Editar</summary>
      <form
        className="org-edit-form"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSave({
            name: String(form.get('name')).trim(),
            slug: String(form.get('slug')).trim(),
            ...(initialDescription !== undefined
              ? { description: String(form.get('description') ?? '') }
              : {}),
          });
        }}
      >
        <label>
          Nome
          <input name="name" defaultValue={initialName} required />
        </label>
        <label>
          Identificador
          <input name="slug" defaultValue={initialSlug} required />
        </label>
        {initialDescription !== undefined && (
          <label>
            Descrição
            <input name="description" defaultValue={initialDescription} />
          </label>
        )}
        <button className="secondary">Salvar</button>
      </form>
    </details>
  );
}

function OrganizationSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const client = useQueryClient();
  const taxonomy = useQuery({
    queryKey: ['org-taxonomy'],
    queryFn: () => api('/org/taxonomy', orgTaxonomySchema),
    enabled: open,
  });
  const change = useMutation({
    mutationFn: ({
      path,
      input,
      method,
    }: {
      path: string;
      input: unknown;
      method: 'POST' | 'PATCH';
    }) => api(path, emptySchema, method === 'POST' ? post(input) : patch(input)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['org-taxonomy'] });
      void client.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const areas = taxonomy.data?.areas ?? [];
  const [selectedArea, setSelectedArea] = useState('');
  const defaultArea = selectedArea || areas[0]?.id || '';
  return (
    <Modal
      title="Configuração organizacional"
      description="Gerencie áreas, subáreas e cargos ativos do CITi."
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="org-settings">
        <ErrorMessage error={taxonomy.error ?? change.error} />
        <section className="org-section">
          <h3>Áreas</h3>
          <form
            className="org-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const name = String(form.get('name')).trim();
              change.mutate({
                path: '/org/areas',
                method: 'POST',
                input: {
                  name,
                  slug: String(form.get('slug') || name)
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-'),
                  description: String(form.get('description') ?? ''),
                },
              });
              event.currentTarget.reset();
            }}
          >
            <input name="name" aria-label="Nome da área" placeholder="Nova área" required />
            <input
              name="slug"
              aria-label="Identificador da área"
              placeholder="identificador (opcional)"
            />
            <input name="description" aria-label="Descrição da área" placeholder="Descrição" />
            <button className="primary" disabled={change.isPending}>
              <Plus size={16} /> Adicionar
            </button>
          </form>
          <div className="org-list">
            {areas.map((area) => (
              <div className="org-row" key={area.id}>
                <div>
                  <strong>{area.name}</strong>
                  <small>{area.description || area.slug}</small>
                </div>
                <TaxonomyEditor
                  initialName={area.name}
                  initialSlug={area.slug}
                  initialDescription={area.description}
                  onSave={(input) =>
                    change.mutate({ path: `/org/areas/${area.id}`, method: 'PATCH', input })
                  }
                />
                <button
                  className="text-button"
                  onClick={() =>
                    change.mutate({
                      path: `/org/areas/${area.id}`,
                      method: 'PATCH',
                      input: { isActive: !area.isActive },
                    })
                  }
                >
                  {area.isActive ? 'Desativar' : 'Ativar'}
                </button>
              </div>
            ))}
          </div>
        </section>
        <section className="org-section">
          <h3>Subáreas</h3>
          <form
            className="org-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const name = String(form.get('name')).trim();
              const areaId = String(form.get('areaId'));
              const parentSlug = areas.find((area) => area.id === areaId)?.slug ?? '';
              change.mutate({
                path: '/org/subareas',
                method: 'POST',
                input: {
                  areaId,
                  name,
                  slug: String(form.get('slug') || `${parentSlug}-${name}`)
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-'),
                },
              });
              event.currentTarget.reset();
            }}
          >
            <select
              name="areaId"
              aria-label="Área da subárea"
              value={defaultArea}
              onChange={(event) => setSelectedArea(event.target.value)}
              required
            >
              {areas
                .filter((area) => area.isActive)
                .map((area) => (
                  <option key={area.id} value={area.id}>
                    {area.name}
                  </option>
                ))}
            </select>
            <input name="name" aria-label="Nome da subárea" placeholder="Nova subárea" required />
            <input
              name="slug"
              aria-label="Identificador da subárea"
              placeholder="identificador (opcional)"
            />
            <button className="primary" disabled={change.isPending}>
              <Plus size={16} /> Adicionar
            </button>
          </form>
          <div className="org-list">
            {areas.flatMap((area) =>
              area.subareas.map((subarea) => (
                <div className="org-row" key={subarea.id}>
                  <div>
                    <strong>{subarea.name}</strong>
                    <small>{area.name}</small>
                  </div>
                  <TaxonomyEditor
                    initialName={subarea.name}
                    initialSlug={subarea.slug}
                    onSave={(input) =>
                      change.mutate({ path: `/org/subareas/${subarea.id}`, method: 'PATCH', input })
                    }
                  />
                  <button
                    className="text-button"
                    onClick={() =>
                      change.mutate({
                        path: `/org/subareas/${subarea.id}`,
                        method: 'PATCH',
                        input: { isActive: !subarea.isActive },
                      })
                    }
                  >
                    {subarea.isActive ? 'Desativar' : 'Ativar'}
                  </button>
                </div>
              )),
            )}
          </div>
        </section>
        <section className="org-section">
          <h3>Cargos</h3>
          <form
            className="org-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const name = String(form.get('name')).trim();
              change.mutate({
                path: '/org/roles',
                method: 'POST',
                input: {
                  name,
                  slug: String(form.get('slug') || name)
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-'),
                },
              });
              event.currentTarget.reset();
            }}
          >
            <input name="name" aria-label="Nome do cargo" placeholder="Novo cargo" required />
            <input
              name="slug"
              aria-label="Identificador do cargo"
              placeholder="identificador (opcional)"
            />
            <button className="primary" disabled={change.isPending}>
              <Plus size={16} /> Adicionar
            </button>
          </form>
          <div className="org-list">
            {taxonomy.data?.roles.map((role) => (
              <div className="org-row" key={role.id}>
                <div>
                  <strong>{role.name}</strong>
                  <small>{role.slug}</small>
                </div>
                <TaxonomyEditor
                  initialName={role.name}
                  initialSlug={role.slug}
                  onSave={(input) =>
                    change.mutate({ path: `/org/roles/${role.id}`, method: 'PATCH', input })
                  }
                />
                <button
                  className="text-button"
                  onClick={() =>
                    change.mutate({
                      path: `/org/roles/${role.id}`,
                      method: 'PATCH',
                      input: { isActive: !role.isActive },
                    })
                  }
                >
                  {role.isActive ? 'Desativar' : 'Ativar'}
                </button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}

export function People({ projects }: { projects: Project[] }) {
  const client = useQueryClient();
  const user = useSession((state) => state.user);
  const admin = user?.role === 'ADMIN';
  const people = useQuery({
    queryKey: ['users'],
    queryFn: () => api('/users', z.array(userSchema)),
  });
  const taxonomy = useQuery({
    queryKey: ['org-taxonomy'],
    queryFn: () => api('/org/taxonomy', orgTaxonomySchema),
  });
  const [editing, setEditing] = useState<User | null>(null);
  const [editArea, setEditArea] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [csv, setCsv] = useState('');
  const [allocation, setAllocation] = useState(false);
  const preview = useMemo(
    () =>
      csv
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, email, area, role, capacity] = line.split(',').map((value) => value.trim());
          return {
            name: name ?? '',
            email: email ?? '',
            area: area ?? '',
            role: role ?? '',
            weeklyCapacityHours: Number(capacity),
          };
        }),
    [csv],
  );
  const saveMember = useMutation({
    mutationFn: (input: unknown) => api(`/users/${editing?.id}/admin`, userSchema, patch(input)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['users'] });
      void client.invalidateQueries({ queryKey: ['heat'] });
      setEditOpen(false);
    },
  });
  const provision = useMutation({
    mutationFn: (members: unknown) =>
      api(
        '/users/bulk-provision',
        bulkResultSchema,
        post(bulkProvisionMembersSchema.parse({ members })),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const allocate = useMutation({
    mutationFn: ({
      projectId,
      ...input
    }: {
      projectId: string;
      userId: string;
      role: string;
      weeklyHours: number;
    }) =>
      api(`/projects/${projectId}/allocations`, ok, { method: 'PUT', body: JSON.stringify(input) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['allocations'] });
      void client.invalidateQueries({ queryKey: ['heat'] });
      setAllocation(false);
    },
  });
  const activeAreas = taxonomy.data?.areas.filter((area) => area.isActive) ?? [];
  const activeRoles = taxonomy.data?.roles.filter((role) => role.isActive) ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">DIRETÓRIO</p>
          <h1>Pessoas & áreas</h1>
          <p className="muted">Perfis, papéis e capacidade semanal.</p>
        </div>
        <div className="heading-actions">
          {(admin || user?.role === 'LEADER') && (
            <button className="secondary" onClick={() => setAllocation(true)}>
              Alocar pessoa
            </button>
          )}
          {admin && (
            <>
              <button className="secondary" onClick={() => setConfigOpen(true)}>
                <Settings2 size={16} /> Configurar organização
              </button>
              <button className="secondary" onClick={() => setBulkOpen(true)}>
                <Upload size={16} /> Importar membros
              </button>
            </>
          )}
        </div>
      </div>
      <div className="toolbar">
        <input
          aria-label="Buscar pessoas"
          placeholder="Buscar por nome ou área…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <ErrorMessage error={people.error ?? taxonomy.error} />
      <div className="people-list">
        {people.data
          ?.filter((person) =>
            `${person.name} ${person.area} ${person.title}`
              .toLowerCase()
              .includes(search.toLowerCase()),
          )
          .map((person) => (
            <article
              className={`person-row ${person.active ? '' : 'person-inactive'}`}
              key={person.id}
            >
              <Avatar name={person.name} />
              <div>
                <h3>{person.name}</h3>
                <span className="muted">
                  {person.title} · {person.subarea ?? person.area}
                </span>
              </div>
              <span className="tag">{person.area}</span>
              <span>
                {person.weeklyHours}h <small className="quiet">/ semana</small>
              </span>
              {!person.active && <span className="inactive-badge">Inativo / alumni</span>}
              {admin && (
                <button
                  className="text-button"
                  onClick={() => {
                    setEditing(person);
                    setEditArea(person.area);
                    setEditOpen(true);
                  }}
                >
                  Gerenciar
                </button>
              )}
            </article>
          ))}
      </div>
      <Modal
        title="Gerenciar membro"
        description="Atualize especialidade, cargo, capacidade e acesso à conta."
        open={editOpen}
        onOpenChange={setEditOpen}
      >
        {editing && (
          <form
            className="form-grid"
            key={editing.id}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              saveMember.mutate({
                area: String(form.get('area')),
                subarea: String(form.get('subarea')) || null,
                role: String(form.get('role')),
                systemRole: String(form.get('systemRole')),
                weeklyCapacityHours: Number(form.get('weeklyCapacityHours')),
                isActive: form.get('isActive') === 'on',
              });
            }}
          >
            <label className="full">
              Membro
              <input value={`${editing.name} · ${editing.email}`} readOnly />
            </label>
            <label>
              Área
              <select
                name="area"
                value={editArea || editing.area}
                onChange={(event) => setEditArea(event.target.value)}
                required
              >
                {activeAreas.map((area) => (
                  <option key={area.id} value={area.name}>
                    {area.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Subárea
              <select name="subarea" defaultValue={editing.subarea ?? ''}>
                <option value="">Sem subárea</option>
                {activeAreas
                  .filter((area) => area.name === (editArea || editing.area))
                  .flatMap((area) =>
                    area.subareas
                      .filter((subarea) => subarea.isActive)
                      .map((subarea) => (
                        <option key={subarea.id} value={subarea.name}>
                          {area.name} · {subarea.name}
                        </option>
                      )),
                  )}
              </select>
            </label>
            <label>
              Cargo
              <select name="role" defaultValue={editing.title} required>
                {activeRoles.map((role) => (
                  <option key={role.id} value={role.name}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Papel do sistema
              <select name="systemRole" defaultValue={editing.role}>
                {roleSchema.options.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Capacidade semanal (h)
              <input
                name="weeklyCapacityHours"
                type="number"
                min={1}
                max={40}
                defaultValue={editing.weeklyHours}
                required
              />
            </label>
            <label className="checklist-item">
              <input name="isActive" type="checkbox" defaultChecked={editing.active} /> Conta ativa
            </label>
            <ErrorMessage error={saveMember.error} />
            <button className="primary full" disabled={saveMember.isPending}>
              Salvar alterações
            </button>
          </form>
        )}
      </Modal>
      <Modal
        title="Importar membros em lote"
        description="Cole uma linha por pessoa no formato nome,email,área,cargo,capacidade. O sistema não cria contas para emails que já existem."
        open={bulkOpen}
        onOpenChange={setBulkOpen}
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            provision.mutate(preview.map((row) => ({ ...row, systemRole: 'MEMBER' as const })));
          }}
        >
          <label className="full">
            Linhas CSV
            <textarea
              rows={7}
              value={csv}
              onChange={(event) => setCsv(event.target.value)}
              placeholder={'Nome Sobrenome,nome@citi.org.br,Tech,Desenvolvedor,16'}
            />
          </label>
          <div className="bulk-preview full">
            <strong>Prévia: {preview.length} registros</strong>
            {preview.map((row, index) => (
              <div key={`${row.email}-${index}`}>
                <span>{row.name || 'Nome ausente'}</span>
                <span>{row.email || 'E-mail ausente'}</span>
                <span>
                  {row.area} · {row.role} · {row.weeklyCapacityHours || '—'}h
                </span>
              </div>
            ))}
          </div>
          <ErrorMessage error={provision.error} />
          {provision.data && (
            <p className="notice full">
              {provision.data.createdCount} criados; {provision.data.existingCount} emails já
              existentes.
            </p>
          )}
          <button className="primary full" disabled={provision.isPending || preview.length === 0}>
            Validar e importar
          </button>
        </form>
      </Modal>
      <OrganizationSettings open={configOpen} onOpenChange={setConfigOpen} />
      <Modal title="Alocar pessoa" open={allocation} onOpenChange={setAllocation}>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            allocate.mutate({
              projectId: String(form.get('projectId')),
              userId: String(form.get('userId')),
              role: String(form.get('role')),
              weeklyHours: Number(form.get('weeklyHours')),
            });
          }}
        >
          <label className="full">
            Projeto
            <select name="projectId" required>
              {projects
                .filter((project) => !project.archived && (admin || project.myRole === 'LEADER'))
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="full">
            Pessoa
            <select name="userId" required>
              {people.data
                ?.filter((person) => person.active)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Vínculo no projeto
            <select name="role">
              <option value="MEMBER">Membro</option>
              <option value="LEADER">Líder</option>
            </select>
          </label>
          <label>
            Horas semanais
            <input name="weeklyHours" type="number" min={1} max={40} required />
          </label>
          <ErrorMessage error={allocate.error} />
          <button className="primary full" disabled={allocate.isPending}>
            Salvar alocação
          </button>
        </form>
      </Modal>
    </>
  );
}
