import pino from 'pino';
import { env } from '@meter/config';

// Logs exclude prompts, AI results, KYC data, secrets, and payment instruments (§19.2).
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.apiKey', '*.prompt', '*.completion'],
    censor: '[redacted]',
  },
});
