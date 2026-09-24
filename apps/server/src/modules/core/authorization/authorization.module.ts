import { Module } from '@nestjs/common';
import { env } from '@meter/config';
import { LedgerModule } from '../ledger/ledger.module.ts';
import { AgentCredentialGuard } from './agent-credential.guard.ts';
import { CREDENTIAL_PEPPER } from './agent-principal.ts';
import { AuthorizationService } from './authorization.service.ts';
import { MandatesService } from './mandates.service.ts';

// ponytail: fixed dev pepper outside production (config refuses to boot prod without one).
const DEV_PEPPER = 'meter-dev-credential-pepper-not-for-production';

/** Mandates, credentials, policy and holds. Knows nothing about what is bought. */
@Module({
  imports: [LedgerModule],
  providers: [
    { provide: CREDENTIAL_PEPPER, useFactory: () => env.METER_CREDENTIAL_PEPPER ?? DEV_PEPPER },
    AuthorizationService,
    MandatesService,
    AgentCredentialGuard,
  ],
  exports: [CREDENTIAL_PEPPER, AuthorizationService, MandatesService, AgentCredentialGuard],
})
export class AuthorizationModule {}
