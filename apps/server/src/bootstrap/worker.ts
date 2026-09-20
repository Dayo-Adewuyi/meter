import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.ts';
import { QUEUES } from '../platform/jobs/queues.ts';
import { logger } from '../platform/telemetry/logger.ts';

// Same modules as the API, different entry point (§6.3).
const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
await app.init();
logger.info({ queues: QUEUES }, 'meter worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
