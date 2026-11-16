import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { authResponse } from '@hub/shared';
import { ArrowUpRight } from 'lucide-react';
import { api, post, useSession } from '../core/api';
import { ErrorMessage } from '../core/components';
import { Logo } from '../core/ui/Logo';
export function Login() {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState('');
  const set = useSession((s) => s.set);
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => api('/auth/providers', z.object({ google: z.boolean() })),
  });
  const login = useMutation({
    mutationFn: () => api('/auth/login', authResponse, post({ email, password })),
    onSuccess: set,
  });
  return (
    <main className="login">
      <section className="login-story">
        <a href="/" className="brand" aria-label="CITi Hub — início">
          <Logo variant="dark" size="login" />
        </a>
        <div>
          <p className="eyebrow">PESSOAS. PROJETOS. CONTINUIDADE.</p>
          <h1>
            Grandes entregas
            <br />
            começam com
            <br />
            <em>conexão.</em>
          </h1>
          <p>
            O ponto de encontro entre o talento da sua EJ e o próximo impacto que vocês vão criar.
          </p>
        </div>
        <small>Conhecimento que fica. Uma gestão que evolui.</small>
      </section>
      <section className="login-form">
        <p className="eyebrow">SEU ESPAÇO DE TRABALHO</p>
        <h2>Vamos construir juntos.</h2>
        <p className="muted">Entre com a conta provisionada pela sua diretoria.</p>
        {providers.data?.google && (
          <a className="button secondary" href="/api/v1/auth/google">
            Entrar com Google Workspace <ArrowUpRight size={18} />
          </a>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate();
          }}
        >
          <label>
            E-mail institucional
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <ErrorMessage error={login.error} />
          <button className="primary" disabled={login.isPending}>
            {login.isPending ? 'Entrando…' : 'Acessar meu workspace'}
            <ArrowUpRight size={18} />
          </button>
        </form>
        <small className="muted">
          Primeiro acesso? Solicite à diretoria a criação da sua conta.
        </small>
      </section>
    </main>
  );
}
