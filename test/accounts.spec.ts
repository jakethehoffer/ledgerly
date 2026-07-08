import { describe, it, expect } from 'vitest';
import { ACCOUNTS } from '../src/accounts.js';

describe('ACCOUNTS table', () => {
  it('has 14 accounts', () => {
    expect(Object.keys(ACCOUNTS)).toHaveLength(14);
  });

  it('every entry has code matching its key', () => {
    for (const [key, def] of Object.entries(ACCOUNTS)) {
      expect(def.code).toBe(key);
    }
  });

  it('every entry has a non-empty name', () => {
    for (const def of Object.values(ACCOUNTS)) {
      expect(def.name.length).toBeGreaterThan(0);
    }
  });

  it('normalBalance is debit for assets and expenses', () => {
    expect(ACCOUNTS['1000'].normalBalance).toBe('debit');
    expect(ACCOUNTS['1010'].normalBalance).toBe('debit');
    expect(ACCOUNTS['6000'].normalBalance).toBe('debit');
    expect(ACCOUNTS['4900'].normalBalance).toBe('debit'); // contra-revenue
  });

  it('normalBalance is credit for liabilities and revenue', () => {
    expect(ACCOUNTS['2000'].normalBalance).toBe('credit');
    expect(ACCOUNTS['2100'].normalBalance).toBe('credit');
    expect(ACCOUNTS['4000'].normalBalance).toBe('credit');
  });

  it('matches the design-spec snapshot', () => {
    expect(ACCOUNTS).toMatchInlineSnapshot(`
      {
        "1000": {
          "code": "1000",
          "name": "Operating Bank",
          "normalBalance": "debit",
          "type": "Asset",
        },
        "1010": {
          "code": "1010",
          "name": "Stripe Clearing",
          "normalBalance": "debit",
          "type": "Asset",
        },
        "1100": {
          "code": "1100",
          "name": "Accounts Receivable",
          "normalBalance": "debit",
          "type": "Asset",
        },
        "1200": {
          "code": "1200",
          "name": "Disputes Receivable",
          "normalBalance": "debit",
          "type": "Asset",
        },
        "2000": {
          "code": "2000",
          "name": "Sales Tax Payable",
          "normalBalance": "credit",
          "type": "Liability",
        },
        "2100": {
          "code": "2100",
          "name": "Deferred Revenue",
          "normalBalance": "credit",
          "type": "Liability",
        },
        "2200": {
          "code": "2200",
          "name": "Customer Credit Balance",
          "normalBalance": "credit",
          "type": "Liability",
        },
        "4000": {
          "code": "4000",
          "name": "Subscription Revenue",
          "normalBalance": "credit",
          "type": "Revenue",
        },
        "4100": {
          "code": "4100",
          "name": "Application Fee Revenue",
          "normalBalance": "credit",
          "type": "Revenue",
        },
        "4900": {
          "code": "4900",
          "name": "Refunds Issued",
          "normalBalance": "debit",
          "type": "ContraRevenue",
        },
        "6000": {
          "code": "6000",
          "name": "Stripe Processing Fees",
          "normalBalance": "debit",
          "type": "Expense",
        },
        "6100": {
          "code": "6100",
          "name": "Payment Disputes",
          "normalBalance": "debit",
          "type": "Expense",
        },
        "6200": {
          "code": "6200",
          "name": "Bad Debt Expense",
          "normalBalance": "debit",
          "type": "Expense",
        },
        "7000": {
          "code": "7000",
          "name": "FX Gain/Loss",
          "normalBalance": "credit",
          "type": "OtherIncome",
        },
      }
    `);
  });
});
