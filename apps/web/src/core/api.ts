import { z } from 'zod';
import { authResponse } from '@hub/shared';
import type { User } from '@hub/shared';
import { create } from 'zustand';
export const useSession = create<{
  user: User | null;
  accessToken: string | null;
  set: (data: z.infer<typeof authResponse> | null) => void;
}>((set) => ({
  user: null,
  accessToken: null,
  set: (data) => set(data ?? { user: null, accessToken: null }),
}));
let refreshPromise: Promise<boolean> | null = null;
export async function refresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const response = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return false;
      useSession.getState().set(authResponse.parse(await response.json()));
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = useSession.getState().accessToken;
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refresh()) return api(path, schema, options, false);
    useSession.getState().set(null);
  }
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new ApiError(502, 'A API está indisponível. Verifique a conexão e tente novamente.');
  if (!response.ok) {
    const body: z.infer<ReturnType<typeof errorSchema>> = errorSchema().parse(
      await response.json(),
    );
    throw new ApiError(response.status, body.message);
  }
  return schema.parse(await response.json());
}
const errorSchema = () =>
  z.object({ message: z.string().default('Não foi possível concluir a ação.') });
export const ok = z.object({ ok: z.boolean() });
export const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
});
export const patch = (body: unknown): RequestInit => ({
  method: 'PATCH',
  body: JSON.stringify(body),
});
export type View = 'workspace' | 'projects' | 'mine' | 'people' | 'heat';
export const useUI = create<{
  view: View;
  projectId: string | null;
  setView: (view: View) => void;
  setProject: (projectId: string) => void;
}>((set) => ({
  view: 'workspace',
  projectId: null,
  setView: (view) => set({ view }),
  setProject: (projectId) => set({ projectId, view: 'workspace' }),
}));
