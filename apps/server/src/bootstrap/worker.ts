import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from '@meter/config';
import { AppModule } from '../app.module.ts';
import { FinalizerService } from '../modules/products/agents/finalizer.service.ts';
import { QUEUES } from '../platform/jobs/queues.ts';
import { logger } from '../platform/telemetry/logger.ts';

// Same modules as the API, different entry point (§6.3).
const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
await app.init();
// Loops run only in the worker; the API process shares the module but never claims work.
if (env.METER_AGENTS_SANDBOX) app.get(FinalizerService).start();
logger.info({ queues: QUEUES }, 'meter worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}
