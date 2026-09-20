import { randomUUID } from 'node:crypto';
import { Controller, Get, Req } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.ts';
import {
  AUTHENTICATOR,
  type AuthenticatorPort,
} from '../modules/core/identity/authenticator.port.ts';
import {
  IDENTITY_REPOSITORY,
  type IdentityRepository,
} from '../modules/core/identity/identity.repository.ts';
import type { MeterPrincipal } from '../modules/core/identity/principal.ts';

const PRINCIPAL: MeterPrincipal = {
  userId: randomUUID(),
  roles: ['customer'],
  restrictionState: 'unrestricted',
};

@Controller('protected')
class ProtectedTestController {
  @Get()
  read(@Req() request: FastifyRequest): { principal: MeterPrincipal | undefined } {
    return { principal: request.principal };
  }
}

const authenticator: AuthenticatorPort = {
  verifyToken: async (token) => {
    if (token !== 'valid') throw new Error('invalid');
    return { provider: 'clerk', subject: 'user_123', sessionId: 'sess_1' };
  },
  fetchUser: async () => ({ provider: 'clerk', subject: 'user_123', disabled: false }),
};

const identities: IdentityRepository = {
  findPrincipal: async (_provider, subject) => (subject === 'user_123' ? PRINCIPAL : null),
};

describe('global authentication', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProtectedTestController],
    })
      .overrideProvider(AUTHENTICATOR)
      .useValue(authenticator)
      .overrideProvider(IDENTITY_REPOSITORY)
      .useValue(identities)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('v1');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('keeps health public', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('denies a protected route with no credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/protected' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('denies a protected route with an unusable token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/protected',
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('carries the internal UUID and roles on a resolved request', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/protected',
      headers: { authorization: 'Bearer valid' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ principal: PRINCIPAL });
  });
});
