import { Module } from '@nestjs/common';
import { CreditDebitService } from './credit-debit.service.ts';
import { RefundService } from './refund.service.ts';
import { ReservationService } from './reservation.service.ts';
import { ReversalService } from './reversal.service.ts';

/** Only this module writes `ledger.*` (§10.1). */
@Module({
  providers: [CreditDebitService, RefundService, ReservationService, ReversalService],
  exports: [CreditDebitService, RefundService, ReservationService, ReversalService],
})
export class LedgerModule {}
