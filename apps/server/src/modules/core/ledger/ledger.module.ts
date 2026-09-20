import { Module } from '@nestjs/common';
import { CreditDebitService } from './credit-debit.service.ts';
import { ReservationService } from './reservation.service.ts';
import { ReversalService } from './reversal.service.ts';

/** Only this module writes `ledger.*` (§10.1). */
@Module({
  providers: [CreditDebitService, ReservationService, ReversalService],
  exports: [CreditDebitService, ReservationService, ReversalService],
})
export class LedgerModule {}
