import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CLASSES,
  ACCOUNT_PURPOSES,
  accountDefinition,
  type AccountDefinition,
  type AccountPurpose,
} from './account-taxonomy.ts';

const CANONICAL_ACCOUNT_CLASSES = [
  'asset',
  'customer_liability',
  'provider_liability',
  'revenue',
  'tax_liability',
  'reserve',
];

const CANONICAL_ACCOUNT_PURPOSES = [
  'customer_available',
  'customer_reserved',
  'customer_pending',
  'provider_payable',
  'meter_revenue',
  'tax_liability',
  'external_cash',
  'reserve',
];

const DEFINITIONS: Record<AccountPurpose, AccountDefinition> = {
  customer_available: { accountClass: 'customer_liability', normalBalance: 'credit' },
  customer_reserved: { accountClass: 'customer_liability', normalBalance: 'credit' },
  customer_pending: { accountClass: 'customer_liability', normalBalance: 'credit' },
  provider_payable: { accountClass: 'provider_liability', normalBalance: 'credit' },
  meter_revenue: { accountClass: 'revenue', normalBalance: 'credit' },
  tax_liability: { accountClass: 'tax_liability', normalBalance: 'credit' },
  external_cash: { accountClass: 'asset', normalBalance: 'debit' },
  reserve: { accountClass: 'reserve', normalBalance: 'debit' },
};

describe('account taxonomy', () => {
  it('exposes the canonical unique account classes and purposes', () => {
    expect(ACCOUNT_CLASSES).toEqual(CANONICAL_ACCOUNT_CLASSES);
    expect(ACCOUNT_PURPOSES).toEqual(CANONICAL_ACCOUNT_PURPOSES);
    expect(new Set(ACCOUNT_CLASSES)).toHaveLength(ACCOUNT_CLASSES.length);
    expect(new Set(ACCOUNT_PURPOSES)).toHaveLength(ACCOUNT_PURPOSES.length);
  });

  it('maps every account purpose to its canonical class and normal balance', () => {
    for (const purpose of ACCOUNT_PURPOSES) {
      expect(accountDefinition(purpose)).toEqual(DEFINITIONS[purpose]);
    }
  });
});
