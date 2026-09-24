/**
 * The only identity an agent route sees (agent-mandates §7). Distinct from
 * `MeterPrincipal`: a human session never satisfies an agent route, nor the
 * reverse.
 */
export interface AgentPrincipal {
  readonly credentialId: string;
  readonly mandateId: string;
  readonly ownerId: string;
  readonly scopes: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentPrincipal;
  }
}

export const CREDENTIAL_PEPPER = Symbol('CREDENTIAL_PEPPER');

export const AGENT_ROUTE = 'meter:agent-route';
