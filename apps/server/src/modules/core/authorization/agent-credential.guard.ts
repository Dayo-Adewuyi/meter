import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { DATABASE } from '../../../platform/database/database.module.ts';
import type { DB } from '../../../platform/database/types.ts';
import { AGENT_ROUTE, type AgentPrincipal, CREDENTIAL_PEPPER } from './agent-principal.ts';
import { parseToken, secretMatches } from './credential-token.ts';

export type AgentAuthCode = 'CREDENTIAL_INVALID' | 'CREDENTIAL_REVOKED' | 'CREDENTIAL_EXPIRED';

const MESSAGES: Record<AgentAuthCode, string> = {
  CREDENTIAL_INVALID: 'The agent credential is not valid.',
  CREDENTIAL_REVOKED: 'The agent credential has been revoked by its owner.',
  CREDENTIAL_EXPIRED: 'The agent credential has expired.',
};

export class AgentAuthDeniedError extends UnauthorizedException {
  constructor(readonly code: AgentAuthCode) {
    super({ error: { code, message: MESSAGES[code] } });
  }
}

/**
 * Fast pre-check for machine requests (§7). It rejects bad tokens cheaply; the
 * authoritative check is policy step 1, under lock, inside the authorization
 * transaction, which is what makes revocation race-free.
 */
@Injectable()
export class AgentCredentialGuard implements CanActivate {
  constructor(
    @Inject(DATABASE) private readonly db: Kysely<DB>,
    @Inject(CREDENTIAL_PEPPER) private readonly pepper: string,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? /^bearer (\S+)$/i.exec(header.trim())?.[1] : undefined;
    const parsed = token === undefined ? null : parseToken(token);
    if (parsed === null) throw new AgentAuthDeniedError('CREDENTIAL_INVALID');

    const credential = await this.db
      .selectFrom('authz.agent_credentials as c')
      .innerJoin('authz.mandates as m', 'm.id', 'c.mandate_id')
      .select(['c.id', 'c.mandate_id', 'c.secret_hash', 'c.status', 'c.expires_at', 'c.scopes', 'm.owner_id'])
      .where('c.public_id', '=', parsed.publicId)
      .executeTakeFirst();
    if (credential === undefined || !secretMatches(this.pepper, parsed.secret, credential.secret_hash)) {
      throw new AgentAuthDeniedError('CREDENTIAL_INVALID');
    }
    if (credential.status !== 'active') throw new AgentAuthDeniedError('CREDENTIAL_REVOKED');
    if (credential.expires_at <= new Date()) throw new AgentAuthDeniedError('CREDENTIAL_EXPIRED');

    // At most one write per credential per minute on the hot path.
    await this.db
      .updateTable('authz.agent_credentials')
      .set({ last_used_at: sql`now()` })
      .where('id', '=', credential.id)
      .where((eb) =>
        eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`)]),
      )
      .execute();

    const principal: AgentPrincipal = {
      credentialId: credential.id,
      mandateId: credential.mandate_id,
      ownerId: credential.owner_id,
      scopes: credential.scopes,
    };
    request.agent = Object.freeze(principal);
    return true;
  }
}

export function requireScope(agent: AgentPrincipal, scope: string): void {
  if (!agent.scopes.includes(scope)) {
    throw new ForbiddenException({ error: { code: 'SCOPE_DENIED', message: `The credential lacks ${scope}.` } });
  }
}

/**
 * Machine-only route. `AuthGuard` steps aside for it and this guard takes over,
 * in one decorator so a route can never end up with neither.
 */
export const AgentRoute = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(AGENT_ROUTE, true), UseGuards(AgentCredentialGuard));
