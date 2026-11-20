import { z } from 'zod';
const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const result = z
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
    AI_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
    AI_CHAT_MODEL: optional,
    OPENAI_API_KEY: optional,
    GEMINI_API_KEY: optional,
    AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
    AI_MODEL: z.string().default('gpt-4.1-mini'),
  })
  .safeParse(process.env);
if (!result.success) {
  console.error(
    'Configuração inválida: ' +
      result.error.issues.map((issue) => issue.path.join('.')).join(', ') +
      '. Execute pnpm setup ou copie .env.example para .env.',
  );
  process.exit(1);
}
export const config = result.data;
if (
  config.NODE_ENV === 'production' &&
  (!config.COOKIE_SECURE || !config.WEB_ORIGIN.startsWith('https://'))
)
  throw new Error('Produção exige HTTPS e cookies Secure.');
