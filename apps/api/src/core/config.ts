import { z } from 'zod';
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
export const config = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().default(3001),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    WEB_ORIGIN: z.string().url(),
    JWT_SECRET: z.string().min(32),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    GOOGLE_CALLBACK_URL: optional,
    GOOGLE_WORKSPACE_DOMAIN: optional,
    AI_API_KEY: optional,
    AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    AI_MODEL: z.string().default('gpt-4.1-mini'),
  })
  .parse(process.env);
if (
  config.NODE_ENV === 'production' &&
  (!config.COOKIE_SECURE || !config.WEB_ORIGIN.startsWith('https://'))
)
  throw new Error('Produção exige HTTPS e cookies Secure.');
