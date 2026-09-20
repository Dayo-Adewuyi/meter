import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { env } from '@meter/config';
import { AppModule } from '../app.module.ts';
import { logger } from '../platform/telemetry/logger.ts';

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({
    // Webhook signature verification needs the exact bytes (§15.1).
    bodyLimit: 1_048_576,
  }),
  // Webhook middleware needs `request.rawBody` (§15.1).
  { bufferLogs: true, rawBody: true },
);

app.setGlobalPrefix('v1');
await app.listen({ port: env.PORT, host: '0.0.0.0' });
logger.info({ port: env.PORT }, 'meter api listening');
