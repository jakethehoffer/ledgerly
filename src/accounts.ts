export type AccountCode =
  | '1000' | '1010' | '1100' | '1200'
  | '2000' | '2100' | '2200'
  | '4000' | '4100' | '4900'
  | '6000' | '6100' | '6200'
  | '7000';

export type AccountType =
  | 'Asset'
  | 'Liability'
  | 'Revenue'
  | 'ContraRevenue'
  | 'Expense'
  | 'OtherIncome';

export type PostingSide = 'debit' | 'credit';

export interface AccountDef {
  readonly code: AccountCode;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: PostingSide;
}

/**
 * Canonical chart of accounts. Single source of truth.
 *
 * 7000 FX Gain/Loss `normalBalance` is `credit` for typing/exporter purposes,
 * but handlers post either side at runtime depending on FX direction.
 */
export const ACCOUNTS: Readonly<Record<AccountCode, AccountDef>> = {
  '1000': { code: '1000', name: 'Operating Bank',          type: 'Asset',         normalBalance: 'debit'  },
  '1010': { code: '1010', name: 'Stripe Clearing',         type: 'Asset',         normalBalance: 'debit'  },
  '1100': { code: '1100', name: 'Accounts Receivable',     type: 'Asset',         normalBalance: 'debit'  },
  '1200': { code: '1200', name: 'Disputes Receivable',     type: 'Asset',         normalBalance: 'debit'  },
  '2000': { code: '2000', name: 'Sales Tax Payable',       type: 'Liability',     normalBalance: 'credit' },
  '2100': { code: '2100', name: 'Deferred Revenue',        type: 'Liability',     normalBalance: 'credit' },
  '2200': { code: '2200', name: 'Customer Credit Balance', type: 'Liability',     normalBalance: 'credit' },
  '4000': { code: '4000', name: 'Subscription Revenue',    type: 'Revenue',       normalBalance: 'credit' },
  '4100': { code: '4100', name: 'Application Fee Revenue', type: 'Revenue',       normalBalance: 'credit' },
  '4900': { code: '4900', name: 'Refunds Issued',          type: 'ContraRevenue', normalBalance: 'debit'  },
  '6000': { code: '6000', name: 'Stripe Processing Fees',  type: 'Expense',       normalBalance: 'debit'  },
  '6100': { code: '6100', name: 'Payment Disputes',        type: 'Expense',       normalBalance: 'debit'  },
  '6200': { code: '6200', name: 'Bad Debt Expense',        type: 'Expense',       normalBalance: 'debit'  },
  '7000': { code: '7000', name: 'FX Gain/Loss',            type: 'OtherIncome',   normalBalance: 'credit' },
} as const;
