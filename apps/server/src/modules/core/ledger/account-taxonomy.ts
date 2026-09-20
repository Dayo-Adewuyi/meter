export const ACCOUNT_CLASSES = [
  'asset',
  'customer_liability',
  'provider_liability',
  'revenue',
  'tax_liability',
  'reserve',
] as const;

export const ACCOUNT_PURPOSES = [
  'customer_available',
  'customer_reserved',
  'customer_pending',
  'provider_payable',
  'meter_revenue',
  'tax_liability',
  'external_cash',
  'reserve',
] as const;

export const SYSTEM_OWNER_ID = '00000000-0000-0000-0000-000000000000';

export type AccountClass = (typeof ACCOUNT_CLASSES)[number];
export type AccountPurpose = (typeof ACCOUNT_PURPOSES)[number];
export type NormalBalance = 'debit' | 'credit';

export interface AccountDefinition {
  accountClass: AccountClass;
  normalBalance: NormalBalance;
}

export function accountDefinition(purpose: AccountPurpose): AccountDefinition {
  switch (purpose) {
    case 'customer_available':
    case 'customer_reserved':
    case 'customer_pending':
      return { accountClass: 'customer_liability', normalBalance: 'credit' };
    case 'provider_payable':
      return { accountClass: 'provider_liability', normalBalance: 'credit' };
    case 'meter_revenue':
      return { accountClass: 'revenue', normalBalance: 'credit' };
    case 'tax_liability':
      return { accountClass: 'tax_liability', normalBalance: 'credit' };
    case 'external_cash':
      return { accountClass: 'asset', normalBalance: 'debit' };
    case 'reserve':
      return { accountClass: 'reserve', normalBalance: 'debit' };
    default: {
      const exhaustivePurpose: never = purpose;
      return exhaustivePurpose;
    }
  }
}
