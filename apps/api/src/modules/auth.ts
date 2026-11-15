import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { loginInput, userSchema } from '@hub/shared';
import type { User } from '@hub/shared';
import type { Principal } from '../core/policy.js';
import { config } from '../core/config.js';
import { db, transaction, HttpError } from '../core/db.js';
import { userColumns } from '../core/records.js';
import { audit } from '../core/access.js';
import { redis } from '../core/redis.js';
declare module 'fastify' {
  interface FastifyRequest {
    actor: Principal;
  }
}
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}
const cookie = {
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
  maxAge: 60 * 60 * 24 * 7,
};
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const opaque = (): string => randomBytes(32).toString('base64url');
export async function authenticate(request: FastifyRequest): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    throw new HttpError(401, 'Sessão expirada.');
  }
  const result = await db.query('SELECT id,role FROM users WHERE id=$1 AND active=true', [
    request.user.sub,
  ]);
  const parsed = z
    .object({ id: z.string().uuid(), role: z.enum(['ADMIN', 'LEADER', 'MEMBER']) })
    .safeParse(result.rows[0]);
  if (!parsed.success) throw new HttpError(401, 'Conta inativa.');
  request.actor = parsed.data;
}
export async function requireAdmin(request: FastifyRequest): Promise<void> {
  if (request.actor.role !== 'ADMIN') throw new HttpError(403, 'Ação exclusiva da diretoria.');
}
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const response = async (
    user: User,
    reply: FastifyReply,
  ): Promise<{ accessToken: string; user: User }> => ({
    accessToken: await reply.jwtSign({ sub: user.id }, { expiresIn: '15m' }),
    user,
  });
  const issue = async (
    user: User,
    reply: FastifyReply,
  ): Promise<{ accessToken: string; user: User }> => {
    const token = opaque();
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO refresh_tokens(hash,user_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
        [digest(token), user.id, crypto.randomUUID()],
      );
      await audit(client, user.id, 'auth.login', user.id, {});
    });
    reply.setCookie('refresh', token, cookie);
    return response(user, reply);
  };
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = loginInput.parse(request.body);
      const result = await db.query(
        `SELECT ${userColumns},password_hash FROM users WHERE email=$1 AND active=true`,
        [input.email.toLowerCase()],
      );
      const row = z
        .object({ password_hash: z.string().nullable() })
        .passthrough()
        .safeParse(result.rows[0]);
      if (
        !row.success ||
        !row.data.password_hash ||
        !(await argon2.verify(row.data.password_hash, input.password))
      )
        throw new HttpError(401, 'Credenciais inválidas.');
      return issue(userSchema.strip().parse(row.data), reply);
    },
  );
  app.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies['refresh'];
    if (!token) throw new HttpError(401, 'Sessão ausente.');
    const next = opaque();
    const result = await transaction(async (client) => {
      const query = await client.query(
        'SELECT user_id,family_id,revoked,expires_at<now() AS expired FROM refresh_tokens WHERE hash=$1 FOR UPDATE',
        [digest(token)],
      );
      const parsed = z
        .object({
          user_id: z.string(),
          family_id: z.string(),
          revoked: z.boolean(),
          expired: z.boolean(),
        })
        .safeParse(query.rows[0]);
      if (!parsed.success) return null;
      const row = parsed.data;
      if (row.revoked || row.expired) {
        await client.query('UPDATE refresh_tokens SET revoked=true WHERE family_id=$1', [
          row.family_id,
        ]);
        return null;
      }
      const users = await client.query(
        `SELECT ${userColumns} FROM users WHERE id=$1 AND active=true`,
        [row.user_id],
      );
      if (!users.rowCount) return null;
      await client.query('UPDATE refresh_tokens SET revoked=true WHERE hash=$1', [digest(token)]);
      await client.query(
        "INSERT INTO refresh_tokens(hash,user_id,family_id,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
        [digest(next), row.user_id, row.family_id],
      );
      return userSchema.parse(users.rows[0]);
    });
    if (!result) {
      reply.clearCookie('refresh', { path: cookie.path });
      throw new HttpError(401, 'Sessão expirada ou reutilizada.');
    }
    reply.setCookie('refresh', next, cookie);
    return response(result, reply);
  });
  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies['refresh'];
    if (token)
      await db.query(
        'UPDATE refresh_tokens SET revoked=true WHERE family_id=(SELECT family_id FROM refresh_tokens WHERE hash=$1)',
        [digest(token)],
      );
    reply.clearCookie('refresh', { path: cookie.path });
    return { ok: true };
  });
  app.get('/auth/me', { preHandler: authenticate }, async (request) =>
    userSchema.parse(
      (await db.query(`SELECT ${userColumns} FROM users WHERE id=$1`, [request.actor.id])).rows[0],
    ),
  );
  app.get('/auth/providers', async () => ({
    google: Boolean(
      config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_CALLBACK_URL,
    ),
  }));
  app.get('/auth/google', async (_request, reply) => {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_CALLBACK_URL)
      throw new HttpError(503, 'SSO não configurado.');
    const state = opaque(),
      nonce = opaque(),
      verifier = opaque(),
      browser = opaque();
    await redis.set(`oauth:${state}`, JSON.stringify({ nonce, verifier, browser }), 'EX', 300);
    // OAuth callback is cross-site; only this short-lived binding cookie needs Lax.
    reply.setCookie('oauth_binding', browser, {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/api/v1/auth/google/callback',
      maxAge: 300,
    });
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      redirect_uri: config.GOOGLE_CALLBACK_URL,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: digest(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    params.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });
  app.get('/auth/google/callback', async (request, reply) => {
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(request.query);
    const stored = await redis.getdel(`oauth:${state}`);
    if (!stored) throw new HttpError(401, 'OAuth state inválido.');
    const flow = z
      .object({ nonce: z.string(), verifier: z.string(), browser: z.string() })
      .parse(JSON.parse(stored));
    if (flow.browser !== request.cookies['oauth_binding'])
      throw new HttpError(401, 'Navegador OAuth inválido.');
    reply.clearCookie('oauth_binding', { path: '/api/v1/auth/google/callback' });
    const tokenResult = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: config.GOOGLE_CLIENT_ID ?? '',
        client_secret: config.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: config.GOOGLE_CALLBACK_URL ?? '',
        grant_type: 'authorization_code',
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!tokenResult.ok) throw new HttpError(401, 'Falha no provedor OAuth.');
    const tokens = z.object({ id_token: z.string() }).parse(await tokenResult.json());
    const verified = await jwtVerify(
      tokens.id_token,
      createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
      {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: config.GOOGLE_CLIENT_ID ?? '',
      },
    );
    const identity = z
      .object({
        sub: z.string(),
        email: z.string().email(),
        email_verified: z.literal(true),
        nonce: z.literal(flow.nonce),
        hd: z.string().optional(),
      })
      .parse(verified.payload);
    if (config.GOOGLE_WORKSPACE_DOMAIN && identity.hd !== config.GOOGLE_WORKSPACE_DOMAIN)
      throw new HttpError(403, 'Workspace não permitido.');
    const result = await db.query(
      `UPDATE users SET google_sub=$2 WHERE email=$1 AND active=true AND (google_sub IS NULL OR google_sub=$2) RETURNING ${userColumns}`,
      [identity.email.toLowerCase(), identity.sub],
    );
    if (!result.rowCount) throw new HttpError(403, 'Conta não provisionada pela diretoria.');
    await issue(userSchema.parse(result.rows[0]), reply);
    return reply.redirect(config.WEB_ORIGIN);
  });
}
