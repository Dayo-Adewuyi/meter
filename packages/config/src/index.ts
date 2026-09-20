import { z } from 'zod';

// Fail at boot, not at the first financial command.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
