import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { projectSchema } from '@hub/shared';
import {
  Waypoints,
  PanelLeft,
  LayoutDashboard,
  FolderKanban,
  UsersRound,
  ChartNoAxesCombined,
  ArrowUpRight,
  LogOut,
  Library,
} from 'lucide-react';
import { api, ok, post, refresh, useSession, useUI } from './core/api';
import type { View } from './core/api';
import { Avatar, Empty, ErrorMessage } from './core/components';
import { Logo } from './core/ui/Logo';
import { Knowledge } from './features/knowledge/Knowledge';
import { Login } from './features/Login';
import { Workspace } from './features/Workspace';
import { Projects, MySpace, Heat } from './features/Pages';
import { People } from './features/People';
import './styles.css';
const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10000 }, mutations: { retry: false } },
});
function App() {
  const user = useSession((s) => s.user),
    [ready, setReady] = useState(false),
    [menu, setMenu] = useState(false),
    [logoutError, setLogoutError] = useState<unknown>(null);
  const { view, setView, projectId, setProject } = useUI();
  useEffect(() => {
    void refresh().finally(() => setReady(true));
  }, []);
  const projects = useQuery({
    queryKey: ['projects', user?.id],
    queryFn: () => api('/projects', z.array(projectSchema)),
    enabled: Boolean(user),
  });
  useEffect(() => {
    if (projects.data?.length && !projects.data.some((p) => p.id === projectId)) {
      const first =
        projects.data.find((p) => !p.archived && p.kind === 'EXTERNAL') ??
        projects.data.find((p) => !p.archived) ??
        projects.data[0];
      if (first) setProject(first.id);
    }
  }, [projects.data, projectId, setProject]);
  if (!ready)
    return (
      <main className="loading">
        <Waypoints size={34} />
        <p>Conectando seu espaço…</p>
      </main>
    );
  if (!user) return <Login />;
  const current = projects.data?.find((p) => p.id === projectId),
    canHeat = user.role !== 'MEMBER' || user.area === 'Gente e Gestão';
  const nav: { id: View; title: string; icon: typeof LayoutDashboard }[] = [
    { id: 'mine', title: 'Meu espaço', icon: LayoutDashboard },
    { id: 'projects', title: 'Projetos', icon: FolderKanban },
    { id: 'people', title: 'Pessoas & áreas', icon: UsersRound },
    { id: 'knowledge', title: 'Memória Institucional', icon: Library },
    ...(canHeat
      ? [{ id: 'heat' as const, title: 'Mapa de alocação', icon: ChartNoAxesCombined }]
      : []),
  ];
  const logout = async () => {
    try {
      await api('/auth/logout', ok, post({}));
      useSession.getState().set(null);
      client.clear();
    } catch (error) {
      setLogoutError(error);
    }
  };
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? 'mobile-open' : ''}`}>
        <a href="/" className="brand" aria-label="CITi Hub — início">
          <Logo variant="dark" />
        </a>
        <span className="nav-label">VISÃO GERAL</span>
        <nav aria-label="Navegação principal">
          {nav.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? 'active' : ''}
              onClick={() => {
                setView(item.id);
                setMenu(false);
              }}
            >
              <item.icon size={18} />
              {item.title}
              {item.id === 'projects' && (
                <span className="nav-count">
                  {projects.data?.filter((p) => !p.archived).length ?? 0}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-section-title">
          <span className="nav-label">SEUS PROJETOS</span>
          <button
            className="icon-button"
            aria-label="Ver projetos"
            onClick={() => setView('projects')}
          >
            <ArrowUpRight size={15} />
          </button>
        </div>
        <nav className="project-navigation" aria-label="Projetos">
          {projects.data
            ?.filter((p) => !p.archived && p.name.trim().toLowerCase() !== 'memória institucional')
            .map((p, index) => (
              <button
                key={p.id}
                className={view === 'workspace' && projectId === p.id ? 'active' : ''}
                onClick={() => {
                  setProject(p.id);
                  setMenu(false);
                }}
              >
                <span className={`project-marker marker-${index % 3}`} />
                <span>{p.name}</span>
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-profile">
            <Avatar name={user.name} />
            <div>
              <strong>{user.name}</strong>
              <small>
                {user.role === 'ADMIN'
                  ? 'Diretoria'
                  : user.role === 'LEADER'
                    ? `Liderança · ${user.area}`
                    : `${user.area} · ${user.title}`}
              </small>
            </div>
            <button
              aria-label="Sair da conta"
              className="icon-button"
              onClick={() => {
                void logout();
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
          <ErrorMessage error={logoutError} />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="Abrir navegação"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              <PanelLeft size={20} />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-separator">/</span>
            <strong>
              {view === 'workspace'
                ? (current?.name ?? 'Projetos')
                : nav.find((n) => n.id === view)?.title}
            </strong>
          </div>
        </header>
        <main className="content">
          <ErrorMessage error={projects.error} />
          {projects.isPending && <p role="status">Carregando projetos…</p>}
          {view === 'workspace' &&
            (current ? (
              <Workspace key={current.id} project={current} />
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <h1>Projetos</h1>
                  </div>
                </div>
                <Empty
                  title="Nenhum projeto vinculado"
                  detail="Crie um projeto no catálogo ou peça à liderança para vincular sua conta."
                />
                <button className="primary" onClick={() => setView('projects')}>
                  Abrir catálogo <ArrowUpRight size={17} />
                </button>
              </>
            ))}
          {view === 'projects' && <Projects projects={projects.data ?? []} />}{' '}
          {view === 'mine' && <MySpace projects={projects.data ?? []} />}{' '}
          {view === 'heat' && <Heat />}
          {view === 'knowledge' && <Knowledge />}
          {view === 'people' && <People projects={projects.data ?? []} />}
        </main>
      </div>
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Elemento raiz ausente.');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
