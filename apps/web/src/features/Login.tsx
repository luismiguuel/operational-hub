import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { authResponse } from '@hub/shared';
import { api, post, useSession } from '../core/api';
import { ErrorMessage } from '../core/components';
import { Logo } from '../core/ui/Logo';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const set = useSession((state) => state.set);
  const login = useMutation({
    mutationFn: () => api('/auth/login', authResponse, post({ email, password })),
    onSuccess: set,
  });

  return (
    <main className="login">
      <section className="login-card" aria-label="Entrar no CITi Hub">
        <Logo variant="dark" size="login" />
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            login.mutate();
          }}
        >
          <label>
            E-mail
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Senha
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <ErrorMessage error={login.error} />
          <button className="primary" type="submit" disabled={login.isPending}>
            {login.isPending ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}
