import { Module } from '@nestjs/common';
import { CreditDebitService } from './credit-debit.service.ts';

/** Only this module writes `ledger.*` (§10.1). */
@Module({ providers: [CreditDebitService], exports: [CreditDebitService] })
export class LedgerModule {}
