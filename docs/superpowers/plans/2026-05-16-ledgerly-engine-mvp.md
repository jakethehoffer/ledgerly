# Ledgerly Engine MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure Stripe→double-entry mapping engine end-to-end for the 5 starter fixtures (`charge.succeeded`, `charge.refunded` partial, `invoice.payment_succeeded` monthly, `invoice.payment_succeeded` annual-deferred, `payout.paid`), plus QBO and Xero exporters with golden-file tests. Spec: [`docs/superpowers/specs/2026-05-16-ledgerly-engine-design.md`](../specs/2026-05-16-ledgerly-engine-design.md).

**Architecture:** Pure function `mapEvent(event: Stripe.Event) => MapResult` dispatching to per-event-type handlers via a static registry. Handlers consume pre-expanded Stripe events, emit balanced `JournalEntry` objects in integer minor units (`Cents`). Exporters are pure functions over a `MapResult`. Tests are fixture-driven: `{name}.event.json` + `{name}.expected.json` + `{name}.qbo.json` + `{name}.xero.json`.

**Tech Stack:** Node 20+, pnpm, TypeScript (strict, NodeNext, ESM), Vitest, ESLint, Prettier, `stripe` package (types only).

---

## File Manifest

| File | Purpose |
|---|---|
| `package.json` | pnpm, `"type": "module"`, scripts |
| `tsconfig.json` | strict, NodeNext, ES2022 |
| `vitest.config.ts` | test runner config |
| `.eslintrc.cjs` | typescript-eslint flat-compat config |
| `.prettierrc.json` | formatter |
| `.gitignore` | node_modules, dist, etc. |
| `src/money.ts` | `Cents` branded type + `cents()` constructor |
| `src/accounts.ts` | `AccountCode` union + `ACCOUNTS` table |
| `src/journal.ts` | `JournalEntry`/`JournalLine`/`RecognitionSchedule`/`MapResult` + balance helpers |
| `src/errors.ts` | `UnhandledEventError`, `MissingExpansionError`, `requireExpanded` (broken out from engine to avoid handler→engine import cycle) |
| `src/engine.ts` | `mapEvent` dispatcher |
| `src/events/index.ts` | `HANDLERS` registry assembly |
| `src/events/charges/chargeSucceeded.ts` | `handleChargeSucceeded` |
| `src/events/charges/chargeRefunded.ts` | `handleChargeRefunded` |
| `src/events/invoices/invoicePaymentSucceeded.ts` | `handleInvoicePaymentSucceeded` (handles monthly + annual-deferred) |
| `src/events/payouts/payoutPaid.ts` | `handlePayoutPaid` |
| `src/util/memo.ts` | memo builders |
| `src/util/dates.ts` | `epochToUtcDate`, `addMonths` |
| `src/util/lines.ts` | `sortLines` (deterministic ordering for goldens) |
| `src/exporters/types.ts` | `QboAccountMap`, `XeroAccountMap` |
| `src/exporters/qbo.ts` | `toQbo`, `toQboSchedule` |
| `src/exporters/xero.ts` | `toXero`, `toXeroSchedule` |
| `test/money.spec.ts` | unit tests for `cents()` |
| `test/accounts.spec.ts` | snapshot test for `ACCOUNTS` |
| `test/journal.spec.ts` | unit tests for `checkBalance` / `assertBalanced` |
| `test/engine.spec.ts` | fixture-driven engine tests |
| `test/exporters/qbo.spec.ts` | fixture-driven QBO golden tests |
| `test/exporters/xero.spec.ts` | fixture-driven Xero golden tests |
| `test/fixtures/charge_succeeded_standard.event.json` | Stripe webhook payload |
| `test/fixtures/charge_succeeded_standard.expected.json` | expected `MapResult` |
| `test/fixtures/charge_succeeded_standard.qbo.json` | expected QBO output |
| `test/fixtures/charge_succeeded_standard.xero.json` | expected Xero output |
| `test/fixtures/charge_refunded_partial.{event,expected,qbo,xero}.json` | fixture trio |
| `test/fixtures/invoice_payment_succeeded_monthly.{event,expected,qbo,xero}.json` | fixture trio |
| `test/fixtures/invoice_payment_succeeded_annual.{event,expected,qbo,xero}.json` | fixture trio (with schedule) |
| `test/fixtures/payout_paid_standard.{event,expected,qbo,xero}.json` | fixture trio |
| `test/fixtures/test-account-maps.ts` | shared stub account maps for exporter tests |

---

## Conventions used in this plan

- **Working directory:** `C:\Users\14jak\GitHub\ledgerly`. All `pnpm` / `git` commands run from there.
- **Line ordering in `JournalEntry.lines`:** debits first (sorted by account code ascending), then credits (same). Bake into handlers via `sortLines`.
- **ESM imports:** import paths end in `.js` even for `.ts` source files (NodeNext convention).
- **Stripe types:** `import type Stripe from 'stripe';` — only for types, no runtime dependency.
- **Fixture IDs:** readable test IDs like `evt_test_charge_001`, `ch_test_001`. Stripe IDs in real fixtures are 20-30 chars; readability wins for tests.
- **Functional currency:** `USD` everywhere in MVP. Handlers throw if `balance_transaction.currency !== 'usd'` (FX path is /goal-phase work).

---

## Task 1: Scaffold project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.eslintrc.cjs`, `.prettierrc.json`, `.gitignore`

- [ ] **Step 1.1: Initialize pnpm**

Run: `pnpm init`
Expected: creates `package.json` with defaults.

- [ ] **Step 1.2: Overwrite `package.json` with the project version**

Replace the entire generated file with:

```json
{
  "name": "ledgerly",
  "version": "0.0.1",
  "description": "Stripe-to-double-entry mapping engine for indie SaaS",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\"",
    "format": "prettier --write \"src/**/*.ts\" \"test/**/*.ts\"",
    "e2e:fixtures": "vitest run test/engine.spec.ts test/exporters"
  },
  "devDependencies": {},
  "dependencies": {}
}
```

- [ ] **Step 1.3: Install dev dependencies**

Run: `pnpm add -D typescript@^5.5 vitest@^2 @types/node@^20 eslint@^8 @typescript-eslint/parser@^7 @typescript-eslint/eslint-plugin@^7 prettier@^3 stripe@^16`
Expected: dependencies installed; `pnpm-lock.yaml` created.

Note: `stripe` is in `devDependencies` because we only use its TypeScript types, not its runtime. Move to `dependencies` later if the engine ever needs the SDK at runtime.

- [ ] **Step 1.4: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 1.5: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    globals: false,
    environment: 'node',
    reporters: ['default'],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 1.6: Create `.eslintrc.cjs`**

```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/strict-type-checked',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
    '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      files: ['test/**/*.ts'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
      },
    },
  ],
  ignorePatterns: ['dist/**', 'node_modules/**', '*.config.ts', '*.cjs'],
};
```

- [ ] **Step 1.7: Create `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "arrowParens": "always",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 1.8: Create `.gitignore`**

```
node_modules/
dist/
coverage/
*.log
.DS_Store
.env
.env.local
.vitest-cache/
```

- [ ] **Step 1.9: Create empty `src/` and `test/` directories with placeholder files so the scaffold commits**

Run: `mkdir src test test/fixtures test/exporters`
Then write `src/.gitkeep` (empty file) and `test/.gitkeep` (empty file).

- [ ] **Step 1.10: Verify scaffolding**

Run: `pnpm typecheck`
Expected: passes (no source files to check yet).

Run: `pnpm test`
Expected: `No test files found` warning, exit 0. (If exit 1, add `passWithNoTests: true` to vitest.config.ts and retry.)

Run: `pnpm lint`
Expected: passes (no source files).

- [ ] **Step 1.11: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .eslintrc.cjs .prettierrc.json .gitignore src test
git commit -m "chore: scaffold pnpm + TypeScript + Vitest + ESLint + Prettier"
```

---

## Task 2: Money — `Cents` branded type

**Files:**
- Create: `src/money.ts`
- Create: `test/money.spec.ts`

- [ ] **Step 2.1: Write the failing test**

Create `test/money.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cents, ZERO_CENTS, type Cents } from '../src/money.js';

describe('cents()', () => {
  it('accepts integer input and returns a Cents-branded number', () => {
    const result: Cents = cents(123);
    expect(result).toBe(123);
  });

  it('accepts zero', () => {
    expect(cents(0)).toBe(0);
  });

  it('accepts negative integers', () => {
    expect(cents(-50)).toBe(-50);
  });

  it('rejects non-integer floats', () => {
    expect(() => cents(1.5)).toThrow(RangeError);
    expect(() => cents(1.5)).toThrow(/integer/i);
  });

  it('rejects NaN', () => {
    expect(() => cents(NaN)).toThrow(RangeError);
  });

  it('rejects Infinity', () => {
    expect(() => cents(Infinity)).toThrow(RangeError);
  });

  it('ZERO_CENTS equals 0', () => {
    expect(ZERO_CENTS).toBe(0);
  });
});
```

- [ ] **Step 2.2: Run test to verify failure**

Run: `pnpm test test/money.spec.ts`
Expected: FAIL — cannot resolve `'../src/money.js'`.

- [ ] **Step 2.3: Implement `src/money.ts`**

```typescript
/** Integer minor units in the journal's functional currency (e.g. USD cents). */
export type Cents = number & { readonly __brand: 'cents' };

/**
 * Construct a Cents value. Throws if `n` is not a finite integer.
 *
 * Money in ledgerly is always stored as integer minor units. The brand prevents
 * accidentally mixing dollars and cents at type-checking time; the runtime check
 * here catches mistakes that escape the type system (e.g. division results).
 */
export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new RangeError(`Cents must be a finite integer, got ${n}`);
  }
  return n as Cents;
}

export const ZERO_CENTS: Cents = cents(0);
```

- [ ] **Step 2.4: Run test to verify pass**

Run: `pnpm test test/money.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 2.5: Commit**

```bash
git add src/money.ts test/money.spec.ts
git commit -m "feat(money): add Cents branded type with runtime integer guard"
```

---

## Task 3: Accounts — `AccountCode` union + `ACCOUNTS` table

**Files:**
- Create: `src/accounts.ts`
- Create: `test/accounts.spec.ts`

- [ ] **Step 3.1: Write the failing test**

Create `test/accounts.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ACCOUNTS, type AccountCode } from '../src/accounts.js';

describe('ACCOUNTS table', () => {
  it('has 12 accounts', () => {
    expect(Object.keys(ACCOUNTS)).toHaveLength(12);
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

  it('all expected codes are present', () => {
    const expected: AccountCode[] = [
      '1000', '1010', '1100', '1200',
      '2000', '2100',
      '4000', '4100', '4900',
      '6000', '6100',
      '7000',
    ];
    for (const code of expected) {
      expect(ACCOUNTS[code]).toBeDefined();
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
```

- [ ] **Step 3.2: Run test to verify failure**

Run: `pnpm test test/accounts.spec.ts`
Expected: FAIL — cannot resolve `'../src/accounts.js'`.

- [ ] **Step 3.3: Implement `src/accounts.ts`**

```typescript
export type AccountCode =
  | '1000' | '1010' | '1100' | '1200'
  | '2000' | '2100'
  | '4000' | '4100' | '4900'
  | '6000' | '6100'
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
  '4000': { code: '4000', name: 'Subscription Revenue',    type: 'Revenue',       normalBalance: 'credit' },
  '4100': { code: '4100', name: 'Application Fee Revenue', type: 'Revenue',       normalBalance: 'credit' },
  '4900': { code: '4900', name: 'Refunds Issued',          type: 'ContraRevenue', normalBalance: 'debit'  },
  '6000': { code: '6000', name: 'Stripe Processing Fees',  type: 'Expense',       normalBalance: 'debit'  },
  '6100': { code: '6100', name: 'Payment Disputes',        type: 'Expense',       normalBalance: 'debit'  },
  '7000': { code: '7000', name: 'FX Gain/Loss',            type: 'OtherIncome',   normalBalance: 'credit' },
} as const;
```

- [ ] **Step 3.4: Run test to verify pass**

Run: `pnpm test test/accounts.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 3.5: Commit**

```bash
git add src/accounts.ts test/accounts.spec.ts
git commit -m "feat(accounts): add canonical chart of accounts with 12 codes"
```

---

## Task 4: Journal types + balance helpers

**Files:**
- Create: `src/journal.ts`
- Create: `test/journal.spec.ts`

- [ ] **Step 4.1: Write the failing test**

Create `test/journal.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { cents } from '../src/money.js';
import { checkBalance, assertBalanced, type JournalEntry } from '../src/journal.js';

const baseEntry = (lines: JournalEntry['lines']): JournalEntry => ({
  date: '2025-01-15',
  currency: 'USD',
  memo: 'test entry',
  sourceEventId: 'evt_test_001',
  sourceEventType: 'charge.succeeded',
  lines,
});

describe('checkBalance', () => {
  it('reports a balanced 2-line entry', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(true);
    expect(report.debitTotal).toBe(10000);
    expect(report.creditTotal).toBe(10000);
    expect(report.difference).toBe(0);
  });

  it('reports a balanced 3-line entry (charge with fee)', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(9680) },
      { accountCode: '6000', side: 'debit', amount: cents(320) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    expect(checkBalance(entry).balanced).toBe(true);
  });

  it('reports unbalanced when debits exceed credits', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10001) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(false);
    expect(report.difference).toBe(1);
  });

  it('reports unbalanced when credits exceed debits', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10001) },
    ]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(false);
    expect(report.difference).toBe(-1);
  });

  it('handles empty lines as balanced zero', () => {
    const entry = baseEntry([]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(true);
    expect(report.debitTotal).toBe(0);
    expect(report.creditTotal).toBe(0);
  });
});

describe('assertBalanced', () => {
  it('does not throw for a balanced entry', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    expect(() => assertBalanced(entry)).not.toThrow();
  });

  it('throws with diagnostic info for an unbalanced entry', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10001) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    expect(() => assertBalanced(entry)).toThrow(/unbalanced/i);
    expect(() => assertBalanced(entry)).toThrow(/evt_test_001/);
    expect(() => assertBalanced(entry)).toThrow(/1/); // difference
  });
});
```

- [ ] **Step 4.2: Run test to verify failure**

Run: `pnpm test test/journal.spec.ts`
Expected: FAIL — cannot resolve `'../src/journal.js'`.

- [ ] **Step 4.3: Implement `src/journal.ts`**

```typescript
import { cents, type Cents } from './money.js';
import type { AccountCode, PostingSide } from './accounts.js';

export interface JournalLine {
  readonly accountCode: AccountCode;
  readonly side: PostingSide;
  readonly amount: Cents;
  readonly memo?: string;
}

export interface JournalEntry {
  readonly date: string;            // ISO YYYY-MM-DD
  readonly currency: string;        // 'USD'
  readonly memo: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly sourceObjectId?: string;
  readonly lines: ReadonlyArray<JournalLine>;
}

export interface RecognitionSchedule {
  readonly subscriptionId: string;
  readonly sourceEventId: string;
  readonly entries: ReadonlyArray<JournalEntry>;
}

export interface MapResult {
  readonly entries: ReadonlyArray<JournalEntry>;
  readonly schedule: RecognitionSchedule | null;
}

export interface BalanceReport {
  readonly debitTotal: Cents;
  readonly creditTotal: Cents;
  readonly difference: number; // signed: + = excess debits
  readonly balanced: boolean;
}

export function checkBalance(entry: JournalEntry): BalanceReport {
  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    if (line.side === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
  }
  const difference = debitTotal - creditTotal;
  return {
    debitTotal: cents(debitTotal),
    creditTotal: cents(creditTotal),
    difference,
    balanced: difference === 0,
  };
}

export function assertBalanced(entry: JournalEntry): void {
  const report = checkBalance(entry);
  if (!report.balanced) {
    throw new Error(
      `Unbalanced journal entry (event ${entry.sourceEventId}): ` +
        `debits=${report.debitTotal} credits=${report.creditTotal} ` +
        `difference=${report.difference}`,
    );
  }
}
```

- [ ] **Step 4.4: Run test to verify pass**

Run: `pnpm test test/journal.spec.ts`
Expected: PASS, 7 tests.

- [ ] **Step 4.5: Commit**

```bash
git add src/journal.ts test/journal.spec.ts
git commit -m "feat(journal): add JournalEntry types + balance validator"
```

---

## Task 5: Engine skeleton + utilities

**Files:**
- Create: `src/errors.ts` (errors + `requireExpanded` — separated to break the engine↔handlers import cycle)
- Create: `src/engine.ts`
- Create: `src/events/index.ts`
- Create: `src/util/dates.ts`
- Create: `src/util/lines.ts`
- Create: `src/util/memo.ts`
- Create: `test/engine.spec.ts` (just the skeleton — unhandled-event throw)

- [ ] **Step 5.1: Write the failing test**

Create `test/engine.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mapEvent } from '../src/engine.js';
import { UnhandledEventError } from '../src/errors.js';

describe('mapEvent', () => {
  it('throws UnhandledEventError for unknown event types', () => {
    const event = {
      id: 'evt_unknown_001',
      type: 'foo.bar.baz',
      data: { object: {} },
    } as unknown as import('stripe').Stripe.Event;

    expect(() => mapEvent(event)).toThrow(UnhandledEventError);
    expect(() => mapEvent(event)).toThrow(/foo\.bar\.baz/);
    expect(() => mapEvent(event)).toThrow(/evt_unknown_001/);
  });
});
```

- [ ] **Step 5.2: Run test to verify failure**

Run: `pnpm test test/engine.spec.ts`
Expected: FAIL — cannot resolve `'../src/engine.js'`.

- [ ] **Step 5.3: Implement `src/util/dates.ts`**

```typescript
/** Convert a Stripe `created` epoch (seconds) to a UTC ISO date `YYYY-MM-DD`. */
export function epochToUtcDate(epochSeconds: number): string {
  if (!Number.isFinite(epochSeconds)) {
    throw new RangeError(`Invalid epoch: ${epochSeconds}`);
  }
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Add `months` to an ISO date string. Clamps to the last day of the target
 * month when the input day doesn't exist there (e.g. Jan 31 + 1 month = Feb 28).
 */
export function addMonths(isoDate: string, months: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new RangeError(`Invalid ISO date: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const totalMonths = month - 1 + months;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12 + 1; // 1-12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}
```

- [ ] **Step 5.4: Implement `src/util/lines.ts`**

```typescript
import type { JournalLine } from '../journal.js';

/**
 * Sort journal lines deterministically: debits first, then credits.
 * Within each side, ascending by account code, then by amount descending
 * (the latter only matters for entries with multiple lines on the same account).
 */
export function sortLines(lines: ReadonlyArray<JournalLine>): ReadonlyArray<JournalLine> {
  return [...lines].sort((a, b) => {
    if (a.side !== b.side) return a.side === 'debit' ? -1 : 1;
    if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
    return b.amount - a.amount;
  });
}
```

- [ ] **Step 5.5: Implement `src/util/memo.ts`**

```typescript
import type Stripe from 'stripe';

function customerLabel(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string {
  if (customer === null || customer === undefined) return 'guest';
  if (typeof customer === 'string') return customer;
  return customer.id;
}

function destinationLabel(destination: Stripe.Payout['destination']): string {
  if (destination === null || destination === undefined) return 'bank';
  if (typeof destination === 'string') return destination;
  return destination.id;
}

export function chargeMemo(charge: Stripe.Charge): string {
  return `Stripe charge ${charge.id} (customer ${customerLabel(charge.customer)})`;
}

export function refundMemo(charge: Stripe.Charge, refundId: string): string {
  return `Stripe refund ${refundId} for charge ${charge.id}`;
}

export function invoiceMemo(invoice: Stripe.Invoice): string {
  return `Stripe invoice ${invoice.id} (customer ${customerLabel(invoice.customer)})`;
}

export function payoutMemo(payout: Stripe.Payout): string {
  return `Stripe payout ${payout.id} to ${destinationLabel(payout.destination)}`;
}
```

- [ ] **Step 5.6: Implement `src/errors.ts`** (broken out from engine to keep handlers from importing engine)

```typescript
export class UnhandledEventError extends Error {
  public readonly eventType: string;
  public readonly eventId: string;
  constructor(eventType: string, eventId: string) {
    super(`No handler registered for event type "${eventType}" (event ${eventId})`);
    this.name = 'UnhandledEventError';
    this.eventType = eventType;
    this.eventId = eventId;
  }
}

export class MissingExpansionError extends Error {
  public readonly field: string;
  public readonly eventId: string;
  constructor(field: string, eventId: string) {
    super(`Expected "${field}" to be an expanded object in event ${eventId}, got string ID`);
    this.name = 'MissingExpansionError';
    this.field = field;
    this.eventId = eventId;
  }
}

/**
 * Require a Stripe nested field to be pre-expanded (an object, not just an ID string).
 *
 * Stripe webhooks do not expand nested objects by default. The ledgerly engine
 * assumes the caller has expanded balance_transaction (and any other needed
 * fields) before invoking mapEvent. This helper enforces that contract.
 */
export function requireExpanded<T>(field: unknown, fieldName: string, eventId: string): T {
  if (field === null || field === undefined || typeof field === 'string') {
    throw new MissingExpansionError(fieldName, eventId);
  }
  return field as T;
}
```

- [ ] **Step 5.7: Implement `src/events/index.ts`** (empty registry for now; populated by later tasks)

```typescript
import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  // populated as handlers are added
};
```

- [ ] **Step 5.8: Implement `src/engine.ts`**

```typescript
import type Stripe from 'stripe';
import { assertBalanced, type MapResult } from './journal.js';
import { HANDLERS } from './events/index.js';
import { UnhandledEventError } from './errors.js';

export function mapEvent(event: Stripe.Event): MapResult {
  const handler = HANDLERS[event.type];
  if (!handler) {
    throw new UnhandledEventError(event.type, event.id);
  }
  const result = handler(event);
  for (const entry of result.entries) assertBalanced(entry);
  if (result.schedule) {
    for (const entry of result.schedule.entries) assertBalanced(entry);
  }
  return result;
}
```

- [ ] **Step 5.9: Run test to verify pass**

Run: `pnpm test test/engine.spec.ts`
Expected: PASS, 1 test.

Also run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5.10: Commit**

```bash
git add src/engine.ts src/errors.ts src/events test/engine.spec.ts src/util
git commit -m "feat(engine): add mapEvent dispatcher + errors + utility helpers"
```

---

## Task 6: `charge.succeeded` handler + standard fixture

**Files:**
- Create: `test/fixtures/charge_succeeded_standard.event.json`
- Create: `test/fixtures/charge_succeeded_standard.expected.json`
- Create: `src/events/charges/chargeSucceeded.ts`
- Modify: `src/events/index.ts` (register the handler)
- Modify: `test/engine.spec.ts` (add fixture-driven loop)

**Scenario:** Customer charged $100.00 USD. Stripe takes a $3.20 fee. No tax, no Connect app fee.
- Posting: Dr 1010 $96.80 + Dr 6000 $3.20 + Cr 4000 $100.00
- Date derived from event `created` epoch `1736942400` → `2025-01-15`

- [ ] **Step 6.1: Create the fixture event payload**

Create `test/fixtures/charge_succeeded_standard.event.json`:

```json
{
  "id": "evt_test_charge_succeeded_001",
  "object": "event",
  "api_version": "2024-12-18.acacia",
  "created": 1736942400,
  "type": "charge.succeeded",
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": null, "idempotency_key": null },
  "data": {
    "object": {
      "id": "ch_test_001",
      "object": "charge",
      "amount": 10000,
      "amount_captured": 10000,
      "amount_refunded": 0,
      "application_fee_amount": null,
      "balance_transaction": {
        "id": "txn_test_001",
        "object": "balance_transaction",
        "amount": 10000,
        "available_on": 1737158400,
        "created": 1736942400,
        "currency": "usd",
        "exchange_rate": null,
        "fee": 320,
        "fee_details": [
          {
            "amount": 320,
            "application": null,
            "currency": "usd",
            "description": "Stripe processing fees",
            "type": "stripe_fee"
          }
        ],
        "net": 9680,
        "reporting_category": "charge",
        "status": "available",
        "type": "charge"
      },
      "captured": true,
      "created": 1736942400,
      "currency": "usd",
      "customer": "cus_test_001",
      "metadata": {},
      "paid": true,
      "refunded": false,
      "status": "succeeded"
    }
  }
}
```

- [ ] **Step 6.2: Create the expected `MapResult`**

Create `test/fixtures/charge_succeeded_standard.expected.json`:

```json
{
  "entries": [
    {
      "date": "2025-01-15",
      "currency": "USD",
      "memo": "Stripe charge ch_test_001 (customer cus_test_001)",
      "sourceEventId": "evt_test_charge_succeeded_001",
      "sourceEventType": "charge.succeeded",
      "sourceObjectId": "ch_test_001",
      "lines": [
        { "accountCode": "1010", "side": "debit", "amount": 9680, "memo": "Net to Stripe balance" },
        { "accountCode": "6000", "side": "debit", "amount": 320, "memo": "Stripe processing fee" },
        { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
      ]
    }
  ],
  "schedule": null
}
```

- [ ] **Step 6.3: Replace `test/engine.spec.ts` with a fixture-driven runner**

Overwrite `test/engine.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapEvent } from '../src/engine.js';
import { UnhandledEventError } from '../src/errors.js';
import { checkBalance } from '../src/journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

function fixtureNames(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.event.json'))
    .map((f) => f.replace('.event.json', ''))
    .sort();
}

describe('mapEvent unknown event', () => {
  it('throws UnhandledEventError for unknown event types', () => {
    const event = {
      id: 'evt_unknown_001',
      type: 'foo.bar.baz',
      data: { object: {} },
    } as unknown as import('stripe').Stripe.Event;

    expect(() => mapEvent(event)).toThrow(UnhandledEventError);
    expect(() => mapEvent(event)).toThrow(/foo\.bar\.baz/);
    expect(() => mapEvent(event)).toThrow(/evt_unknown_001/);
  });
});

describe('mapEvent fixture-driven', () => {
  for (const name of fixtureNames()) {
    it(`maps ${name} to the expected MapResult`, () => {
      const event = loadJson(`${name}.event.json`) as import('stripe').Stripe.Event;
      const expected = loadJson(`${name}.expected.json`);
      const result = mapEvent(event);
      expect(result).toEqual(expected);
    });

    it(`${name}: every entry is balanced`, () => {
      const event = loadJson(`${name}.event.json`) as import('stripe').Stripe.Event;
      const result = mapEvent(event);
      for (const entry of result.entries) {
        expect(checkBalance(entry).balanced).toBe(true);
      }
      if (result.schedule) {
        for (const entry of result.schedule.entries) {
          expect(checkBalance(entry).balanced).toBe(true);
        }
      }
    });
  }
});
```

- [ ] **Step 6.4: Run tests to verify failure**

Run: `pnpm test test/engine.spec.ts`
Expected: FAIL — `UnhandledEventError: No handler registered for event type "charge.succeeded"`.

- [ ] **Step 6.5: Implement `src/events/charges/chargeSucceeded.ts`**

```typescript
import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { chargeMemo } from '../../util/memo.js';

export function handleChargeSucceeded(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.succeeded') {
    throw new Error(`handleChargeSucceeded received wrong event type: ${event.type}`);
  }
  const charge = event.data.object as Stripe.Charge;
  if (charge.currency !== 'usd') {
    throw new Error(
      `Non-USD charges not yet supported (charge ${charge.id} currency=${charge.currency})`,
    );
  }
  if (charge.amount === 0) {
    return { entries: [], schedule: null };
  }

  const bt = requireExpanded<Stripe.BalanceTransaction>(
    charge.balance_transaction,
    'charge.balance_transaction',
    event.id,
  );

  const gross = cents(charge.amount);
  const fee = cents(bt.fee);
  const net = cents(bt.net);

  const lines: JournalLine[] = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,   memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,   memo: 'Stripe processing fee' },
    { accountCode: '4000', side: 'credit', amount: gross, memo: 'Subscription revenue' },
  ]);

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: chargeMemo(charge),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: charge.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
```

- [ ] **Step 6.6: Register the handler in `src/events/index.ts`**

Replace the file's contents:

```typescript
import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
};
```

- [ ] **Step 6.7: Run tests to verify pass**

Run: `pnpm test test/engine.spec.ts`
Expected: PASS, 3 tests (1 unknown-event + 2 fixture tests for `charge_succeeded_standard`).

- [ ] **Step 6.8: Commit**

```bash
git add test/fixtures src/events/charges test/engine.spec.ts src/events/index.ts
git commit -m "feat(events): handle charge.succeeded + add standard fixture"
```

---

## Task 7: `charge.refunded` handler + partial-refund fixture

**Files:**
- Create: `test/fixtures/charge_refunded_partial.event.json`
- Create: `test/fixtures/charge_refunded_partial.expected.json`
- Create: `src/events/charges/chargeRefunded.ts`
- Modify: `src/events/index.ts`

**Scenario:** $30.00 partial refund of the prior $100 charge. Stripe doesn't refund the original processing fee.
- Posting: Dr 4900 $30.00 / Cr 1010 $30.00
- Refund's own balance_transaction is a separate `txn_` with `amount = -3000`, `fee = 0`, `net = -3000` for the refund leg.

- [ ] **Step 7.1: Create the fixture event payload**

Create `test/fixtures/charge_refunded_partial.event.json`:

```json
{
  "id": "evt_test_charge_refunded_001",
  "object": "event",
  "api_version": "2024-12-18.acacia",
  "created": 1737115200,
  "type": "charge.refunded",
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": null, "idempotency_key": null },
  "data": {
    "object": {
      "id": "ch_test_001",
      "object": "charge",
      "amount": 10000,
      "amount_captured": 10000,
      "amount_refunded": 3000,
      "balance_transaction": "txn_test_001",
      "captured": true,
      "created": 1736942400,
      "currency": "usd",
      "customer": "cus_test_001",
      "metadata": {},
      "paid": true,
      "refunded": false,
      "status": "succeeded",
      "refunds": {
        "object": "list",
        "data": [
          {
            "id": "re_test_001",
            "object": "refund",
            "amount": 3000,
            "balance_transaction": {
              "id": "txn_test_refund_001",
              "object": "balance_transaction",
              "amount": -3000,
              "available_on": 1737331200,
              "created": 1737115200,
              "currency": "usd",
              "exchange_rate": null,
              "fee": 0,
              "fee_details": [],
              "net": -3000,
              "reporting_category": "refund",
              "status": "available",
              "type": "refund"
            },
            "charge": "ch_test_001",
            "created": 1737115200,
            "currency": "usd",
            "reason": "requested_by_customer",
            "status": "succeeded"
          }
        ],
        "has_more": false,
        "total_count": 1,
        "url": "/v1/charges/ch_test_001/refunds"
      }
    }
  }
}
```

- [ ] **Step 7.2: Create the expected `MapResult`**

Create `test/fixtures/charge_refunded_partial.expected.json`:

```json
{
  "entries": [
    {
      "date": "2025-01-17",
      "currency": "USD",
      "memo": "Stripe refund re_test_001 for charge ch_test_001",
      "sourceEventId": "evt_test_charge_refunded_001",
      "sourceEventType": "charge.refunded",
      "sourceObjectId": "re_test_001",
      "lines": [
        { "accountCode": "4900", "side": "debit", "amount": 3000, "memo": "Refund issued" },
        { "accountCode": "1010", "side": "credit", "amount": 3000, "memo": "Refund deducted from Stripe balance" }
      ]
    }
  ],
  "schedule": null
}
```

- [ ] **Step 7.3: Run tests to verify failure**

Run: `pnpm test test/engine.spec.ts`
Expected: FAIL — `UnhandledEventError: No handler registered for event type "charge.refunded"`.

- [ ] **Step 7.4: Implement `src/events/charges/chargeRefunded.ts`**

`charge.refunded` fires once per refund action on a charge. The fixture's `refunds.data` array holds the new refund as its last element. For MVP we emit one journal entry per refund in `refunds.data` whose own balance_transaction reflects this event's date (i.e., refunds created at this event's `created`). A multi-refund sequence (later /goal fixture) will refine this.

```typescript
import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { refundMemo } from '../../util/memo.js';

export function handleChargeRefunded(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.refunded') {
    throw new Error(`handleChargeRefunded received wrong event type: ${event.type}`);
  }
  const charge = event.data.object as Stripe.Charge;
  if (charge.currency !== 'usd') {
    throw new Error(
      `Non-USD refunds not yet supported (charge ${charge.id} currency=${charge.currency})`,
    );
  }

  const refundsList = charge.refunds;
  if (!refundsList || refundsList.data.length === 0) {
    return { entries: [], schedule: null };
  }

  // Emit one entry per refund created at this event's `created` time.
  // Stripe redelivers prior refunds in the list; we only post the ones with
  // created === event.created to avoid double-posting on subsequent refunds.
  const newRefunds = refundsList.data.filter((r) => r.created === event.created);
  const targetRefunds = newRefunds.length > 0 ? newRefunds : refundsList.data;

  const entries: JournalEntry[] = targetRefunds.map((refund) => {
    requireExpanded<Stripe.BalanceTransaction>(
      refund.balance_transaction,
      `refund[${refund.id}].balance_transaction`,
      event.id,
    );

    const amount = cents(refund.amount);
    const lines: JournalLine[] = sortLines([
      { accountCode: '4900', side: 'debit',  amount, memo: 'Refund issued' },
      { accountCode: '1010', side: 'credit', amount, memo: 'Refund deducted from Stripe balance' },
    ]);

    return {
      date: epochToUtcDate(refund.created),
      currency: 'USD',
      memo: refundMemo(charge, refund.id),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: refund.id,
      lines,
    };
  });

  return { entries, schedule: null };
}
```

- [ ] **Step 7.5: Register the handler**

Modify `src/events/index.ts`:

```typescript
import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';
import { handleChargeRefunded } from './charges/chargeRefunded.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
};
```

- [ ] **Step 7.6: Run tests to verify pass**

Run: `pnpm test test/engine.spec.ts`
Expected: PASS, 5 tests (1 unknown-event + 2×2 fixtures).

- [ ] **Step 7.7: Commit**

```bash
git add test/fixtures src/events/charges/chargeRefunded.ts src/events/index.ts
git commit -m "feat(events): handle charge.refunded + add partial-refund fixture"
```

---

## Task 8: `invoice.payment_succeeded` handler + monthly fixture

**Files:**
- Create: `test/fixtures/invoice_payment_succeeded_monthly.event.json`
- Create: `test/fixtures/invoice_payment_succeeded_monthly.expected.json`
- Create: `src/events/invoices/invoicePaymentSucceeded.ts`
- Modify: `src/events/index.ts`

**Scenario:** Monthly subscription renewal of $50.00. Stripe fee $1.75. Single line item with `period.start..period.end` covering one month.
- Posting: Dr 1010 $48.25 / Dr 6000 $1.75 / Cr 4000 $50.00 (recognized immediately — period is a single month)
- No deferred revenue; no schedule.

- [ ] **Step 8.1: Create the fixture event payload**

Create `test/fixtures/invoice_payment_succeeded_monthly.event.json`:

```json
{
  "id": "evt_test_invoice_monthly_001",
  "object": "event",
  "api_version": "2024-12-18.acacia",
  "created": 1736942400,
  "type": "invoice.payment_succeeded",
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": null, "idempotency_key": null },
  "data": {
    "object": {
      "id": "in_test_monthly_001",
      "object": "invoice",
      "amount_due": 5000,
      "amount_paid": 5000,
      "amount_remaining": 0,
      "billing_reason": "subscription_cycle",
      "charge": {
        "id": "ch_test_monthly_001",
        "object": "charge",
        "amount": 5000,
        "balance_transaction": {
          "id": "txn_test_monthly_001",
          "object": "balance_transaction",
          "amount": 5000,
          "currency": "usd",
          "exchange_rate": null,
          "fee": 175,
          "fee_details": [
            { "amount": 175, "currency": "usd", "description": "Stripe processing fees", "type": "stripe_fee" }
          ],
          "net": 4825,
          "reporting_category": "charge",
          "status": "available",
          "type": "charge",
          "created": 1736942400,
          "available_on": 1737158400
        },
        "currency": "usd",
        "paid": true,
        "status": "succeeded"
      },
      "created": 1736942400,
      "currency": "usd",
      "customer": "cus_test_monthly_001",
      "lines": {
        "object": "list",
        "data": [
          {
            "id": "il_test_monthly_001",
            "object": "line_item",
            "amount": 5000,
            "currency": "usd",
            "period": { "start": 1736942400, "end": 1739620800 },
            "proration": false,
            "subscription": "sub_test_monthly_001",
            "type": "subscription"
          }
        ],
        "has_more": false,
        "total_count": 1,
        "url": "/v1/invoices/in_test_monthly_001/lines"
      },
      "paid": true,
      "status": "paid",
      "subscription": "sub_test_monthly_001",
      "total": 5000
    }
  }
}
```

- [ ] **Step 8.2: Create the expected `MapResult`**

Create `test/fixtures/invoice_payment_succeeded_monthly.expected.json`:

```json
{
  "entries": [
    {
      "date": "2025-01-15",
      "currency": "USD",
      "memo": "Stripe invoice in_test_monthly_001 (customer cus_test_monthly_001)",
      "sourceEventId": "evt_test_invoice_monthly_001",
      "sourceEventType": "invoice.payment_succeeded",
      "sourceObjectId": "in_test_monthly_001",
      "lines": [
        { "accountCode": "1010", "side": "debit", "amount": 4825, "memo": "Net to Stripe balance" },
        { "accountCode": "6000", "side": "debit", "amount": 175, "memo": "Stripe processing fee" },
        { "accountCode": "4000", "side": "credit", "amount": 5000, "memo": "Subscription revenue (1-month period)" }
      ]
    }
  ],
  "schedule": null
}
```

- [ ] **Step 8.3: Run tests to verify failure**

Run: `pnpm test test/engine.spec.ts`
Expected: FAIL — `UnhandledEventError: No handler registered for event type "invoice.payment_succeeded"`.

- [ ] **Step 8.4: Implement `src/events/invoices/invoicePaymentSucceeded.ts`**

The handler decides "monthly vs annual" by inspecting the largest line item's period span. <= 32 days → monthly (no deferred). > 32 days → defer the full amount and emit a recognition schedule (filled in by Task 9).

```typescript
import type Stripe from 'stripe';
import { cents, type Cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult, RecognitionSchedule } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate, addMonths } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';

const SECONDS_PER_DAY = 86400;
const MONTHLY_THRESHOLD_DAYS = 32;

function periodSpanDays(invoice: Stripe.Invoice): number {
  let maxSpan = 0;
  for (const line of invoice.lines.data) {
    const span = (line.period.end - line.period.start) / SECONDS_PER_DAY;
    if (span > maxSpan) maxSpan = span;
  }
  return maxSpan;
}

function periodMonths(invoice: Stripe.Invoice): number {
  // Approximate months by dividing the longest period span. 12 for annual, 1 for monthly.
  const days = periodSpanDays(invoice);
  return Math.max(1, Math.round(days / 30));
}

function getCharge(invoice: Stripe.Invoice, eventId: string): Stripe.Charge {
  return requireExpanded<Stripe.Charge>(invoice.charge, 'invoice.charge', eventId);
}

function getBalanceTxn(charge: Stripe.Charge, eventId: string): Stripe.BalanceTransaction {
  return requireExpanded<Stripe.BalanceTransaction>(
    charge.balance_transaction,
    'invoice.charge.balance_transaction',
    eventId,
  );
}

function buildMonthlyEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  fee: Cents,
  net: Cents,
): JournalEntry {
  const lines: JournalLine[] = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,   memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,   memo: 'Stripe processing fee' },
    { accountCode: '4000', side: 'credit', amount: gross, memo: 'Subscription revenue (1-month period)' },
  ]);
  return {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines,
  };
}

function buildAnnualCashEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  fee: Cents,
  net: Cents,
): JournalEntry {
  const lines: JournalLine[] = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,   memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,   memo: 'Stripe processing fee' },
    { accountCode: '2100', side: 'credit', amount: gross, memo: 'Annual subscription deferred' },
  ]);
  return {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines,
  };
}

function buildRecognitionSchedule(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  months: number,
): RecognitionSchedule {
  const subscriptionId =
    typeof invoice.subscription === 'string'
      ? invoice.subscription
      : invoice.subscription?.id ?? 'unknown';

  const cashDate = epochToUtcDate(event.created);
  const baseAmount = Math.floor(gross / months);
  const remainder = gross - baseAmount * months;

  const entries: JournalEntry[] = [];
  for (let m = 1; m <= months; m++) {
    // Last entry absorbs the remainder so the schedule's sum equals gross exactly.
    const monthAmount = cents(m === months ? baseAmount + remainder : baseAmount);
    entries.push({
      date: addMonths(cashDate, m),
      currency: 'USD',
      memo: `${invoiceMemo(invoice)} — month ${m}/${months} recognition`,
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines: sortLines([
        { accountCode: '2100', side: 'debit',  amount: monthAmount, memo: 'Recognize from deferred' },
        { accountCode: '4000', side: 'credit', amount: monthAmount, memo: 'Subscription revenue' },
      ]),
    });
  }

  return {
    subscriptionId,
    sourceEventId: event.id,
    entries,
  };
}

export function handleInvoicePaymentSucceeded(event: Stripe.Event): MapResult {
  if (event.type !== 'invoice.payment_succeeded') {
    throw new Error(`handleInvoicePaymentSucceeded received wrong event type: ${event.type}`);
  }
  const invoice = event.data.object as Stripe.Invoice;
  if (invoice.currency !== 'usd') {
    throw new Error(
      `Non-USD invoices not yet supported (invoice ${invoice.id} currency=${invoice.currency})`,
    );
  }
  if (invoice.amount_paid === 0) {
    return { entries: [], schedule: null };
  }

  const charge = getCharge(invoice, event.id);
  const bt = getBalanceTxn(charge, event.id);

  const gross = cents(invoice.amount_paid);
  const fee = cents(bt.fee);
  const net = cents(bt.net);

  const span = periodSpanDays(invoice);
  if (span <= MONTHLY_THRESHOLD_DAYS) {
    return {
      entries: [buildMonthlyEntry(event, invoice, gross, fee, net)],
      schedule: null,
    };
  }

  const months = periodMonths(invoice);
  return {
    entries: [buildAnnualCashEntry(event, invoice, gross, fee, net)],
    schedule: buildRecognitionSchedule(event, invoice, gross, months),
  };
}
```

- [ ] **Step 8.5: Register the handler**

Modify `src/events/index.ts`:

```typescript
import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';
import { handleChargeRefunded } from './charges/chargeRefunded.js';
import { handleInvoicePaymentSucceeded } from './invoices/invoicePaymentSucceeded.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
};
```

- [ ] **Step 8.6: Run tests to verify pass**

Run: `pnpm test test/engine.spec.ts`
Expected: PASS, 7 tests (1 unknown-event + 3×2 fixtures).

- [ ] **Step 8.7: Commit**

```bash
git add test/fixtures src/events/invoices src/events/index.ts
git commit -m "feat(events): handle invoice.payment_succeeded monthly path"
```

---

## Task 9: `invoice.payment_succeeded` annual-deferred fixture

The handler already supports annual (Task 8 implemented both branches). This task adds the fixture and verifies the schedule output.

**Files:**
- Create: `test/fixtures/invoice_payment_succeeded_annual.event.json`
- Create: `test/fixtures/invoice_payment_succeeded_annual.expected.json`

**Scenario:** Annual sub renewal of $1,200.00 charged 2025-01-15. Stripe fee $36.00. Single line item, `period` = 1 year. Emit: cash entry today + 12-entry recognition schedule (one per month, $100 each, last month absorbs any rounding remainder).

- [ ] **Step 9.1: Create the fixture event payload**

Create `test/fixtures/invoice_payment_succeeded_annual.event.json`:

```json
{
  "id": "evt_test_invoice_annual_001",
  "object": "event",
  "api_version": "2024-12-18.acacia",
  "created": 1736942400,
  "type": "invoice.payment_succeeded",
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": null, "idempotency_key": null },
  "data": {
    "object": {
      "id": "in_test_annual_001",
      "object": "invoice",
      "amount_due": 120000,
      "amount_paid": 120000,
      "amount_remaining": 0,
      "billing_reason": "subscription_cycle",
      "charge": {
        "id": "ch_test_annual_001",
        "object": "charge",
        "amount": 120000,
        "balance_transaction": {
          "id": "txn_test_annual_001",
          "object": "balance_transaction",
          "amount": 120000,
          "currency": "usd",
          "exchange_rate": null,
          "fee": 3600,
          "fee_details": [
            { "amount": 3600, "currency": "usd", "description": "Stripe processing fees", "type": "stripe_fee" }
          ],
          "net": 116400,
          "reporting_category": "charge",
          "status": "available",
          "type": "charge",
          "created": 1736942400,
          "available_on": 1737158400
        },
        "currency": "usd",
        "paid": true,
        "status": "succeeded"
      },
      "created": 1736942400,
      "currency": "usd",
      "customer": "cus_test_annual_001",
      "lines": {
        "object": "list",
        "data": [
          {
            "id": "il_test_annual_001",
            "object": "line_item",
            "amount": 120000,
            "currency": "usd",
            "period": { "start": 1736942400, "end": 1768478400 },
            "proration": false,
            "subscription": "sub_test_annual_001",
            "type": "subscription"
          }
        ],
        "has_more": false,
        "total_count": 1,
        "url": "/v1/invoices/in_test_annual_001/lines"
      },
      "paid": true,
      "status": "paid",
      "subscription": "sub_test_annual_001",
      "total": 120000
    }
  }
}
```

(Period: `1736942400` = 2025-01-15, `1768478400` = 2026-01-15. Span = 365 days.)

- [ ] **Step 9.2: Create the expected `MapResult`**

`$1,200.00 / 12 = $100.00` exactly — no rounding remainder. Each schedule entry is $100.00 on the 15th of months Feb 2025 through Jan 2026.

Create `test/fixtures/invoice_payment_succeeded_annual.expected.json`:

```json
{
  "entries": [
    {
      "date": "2025-01-15",
      "currency": "USD",
      "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001)",
      "sourceEventId": "evt_test_invoice_annual_001",
      "sourceEventType": "invoice.payment_succeeded",
      "sourceObjectId": "in_test_annual_001",
      "lines": [
        { "accountCode": "1010", "side": "debit", "amount": 116400, "memo": "Net to Stripe balance" },
        { "accountCode": "6000", "side": "debit", "amount": 3600, "memo": "Stripe processing fee" },
        { "accountCode": "2100", "side": "credit", "amount": 120000, "memo": "Annual subscription deferred" }
      ]
    }
  ],
  "schedule": {
    "subscriptionId": "sub_test_annual_001",
    "sourceEventId": "evt_test_invoice_annual_001",
    "entries": [
      {
        "date": "2025-02-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 1/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-03-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 2/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-04-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 3/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-05-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 4/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-06-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 5/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-07-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 6/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-08-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 7/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-09-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 8/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-10-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 9/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-11-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 10/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2025-12-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 11/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      },
      {
        "date": "2026-01-15",
        "currency": "USD",
        "memo": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001) — month 12/12 recognition",
        "sourceEventId": "evt_test_invoice_annual_001",
        "sourceEventType": "invoice.payment_succeeded",
        "sourceObjectId": "in_test_annual_001",
        "lines": [
          { "accountCode": "2100", "side": "debit", "amount": 10000, "memo": "Recognize from deferred" },
          { "accountCode": "4000", "side": "credit", "amount": 10000, "memo": "Subscription revenue" }
        ]
      }
    ]
  }
}
```

The `—` is `—` (em dash). The memo built by the handler uses `${invoiceMemo(invoice)} — month ${m}/${months} recognition`. JSON.stringify will round-trip this correctly; the comparison is structural so either literal `—` or `—` works.

- [ ] **Step 9.3: Run tests to verify pass**

Run: `pnpm test test/engine.spec.ts`
Expected: PASS, 9 tests (1 unknown-event + 4×2 fixtures).

If FAIL on schedule contents, double-check `addMonths` is called once per month index (1 through 12) and that the memo string uses `—` (not `-`).

- [ ] **Step 9.4: Commit**

```bash
git add test/fixtures
git commit -m "feat(events): add annual-deferred invoice fixture with 12-month recognition schedule"
```

---

## Task 10: `payout.paid` handler + fixture

**Files:**
- Create: `test/fixtures/payout_paid_standard.event.json`
- Create: `test/fixtures/payout_paid_standard.expected.json`
- Create: `src/events/payouts/payoutPaid.ts`
- Modify: `src/events/index.ts`

**Scenario:** Stripe pays out $5,000 to the user's bank.
- Posting: Dr 1000 $5,000 / Cr 1010 $5,000
- Date is the `arrival_date` epoch (when ACH lands), not `event.created`.

- [ ] **Step 10.1: Create the fixture event payload**

Create `test/fixtures/payout_paid_standard.event.json`:

```json
{
  "id": "evt_test_payout_001",
  "object": "event",
  "api_version": "2024-12-18.acacia",
  "created": 1737633600,
  "type": "payout.paid",
  "livemode": false,
  "pending_webhooks": 1,
  "request": { "id": null, "idempotency_key": null },
  "data": {
    "object": {
      "id": "po_test_001",
      "object": "payout",
      "amount": 500000,
      "arrival_date": 1737676800,
      "automatic": true,
      "balance_transaction": "txn_test_payout_001",
      "created": 1737374400,
      "currency": "usd",
      "destination": "ba_test_001",
      "method": "standard",
      "source_type": "card",
      "status": "paid",
      "type": "bank_account"
    }
  }
}
```

(`arrival_date` 1737676800 = 2025-01-24.)

- [ ] **Step 10.2: Create the expected `MapResult`**

Create `test/fixtures/payout_paid_standard.expected.json`:

```json
{
  "entries": [
    {
      "date": "2025-01-24",
      "currency": "USD",
      "memo": "Stripe payout po_test_001 to ba_test_001",
      "sourceEventId": "evt_test_payout_001",
      "sourceEventType": "payout.paid",
      "sourceObjectId": "po_test_001",
      "lines": [
        { "accountCode": "1000", "side": "debit", "amount": 500000, "memo": "Funds arrived in bank" },
        { "accountCode": "1010", "side": "credit", "amount": 500000, "memo": "Funds left Stripe balance" }
      ]
    }
  ],
  "schedule": null
}
```

- [ ] **Step 10.3: Run tests to verify failure**

Run: `pnpm test test/engine.spec.ts`
Expected: FAIL — `UnhandledEventError: No handler registered for event type "payout.paid"`.

- [ ] **Step 10.4: Implement `src/events/payouts/payoutPaid.ts`**

```typescript
import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { payoutMemo } from '../../util/memo.js';

export function handlePayoutPaid(event: Stripe.Event): MapResult {
  if (event.type !== 'payout.paid') {
    throw new Error(`handlePayoutPaid received wrong event type: ${event.type}`);
  }
  const payout = event.data.object as Stripe.Payout;
  if (payout.currency !== 'usd') {
    throw new Error(
      `Non-USD payouts not yet supported (payout ${payout.id} currency=${payout.currency})`,
    );
  }
  if (payout.amount === 0) {
    return { entries: [], schedule: null };
  }

  const amount = cents(payout.amount);
  const lines: JournalLine[] = sortLines([
    { accountCode: '1000', side: 'debit',  amount, memo: 'Funds arrived in bank' },
    { accountCode: '1010', side: 'credit', amount, memo: 'Funds left Stripe balance' },
  ]);

  const entry: JournalEntry = {
    date: epochToUtcDate(payout.arrival_date),
    currency: 'USD',
    memo: payoutMemo(payout),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: payout.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
```

- [ ] **Step 10.5: Register the handler**

Modify `src/events/index.ts`:

```typescript
import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';
import { handleChargeRefunded } from './charges/chargeRefunded.js';
import { handleInvoicePaymentSucceeded } from './invoices/invoicePaymentSucceeded.js';
import { handlePayoutPaid } from './payouts/payoutPaid.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
  'payout.paid': handlePayoutPaid,
};
```

- [ ] **Step 10.6: Run tests to verify pass**

Run: `pnpm test test/engine.spec.ts`
Expected: PASS, 11 tests (1 unknown-event + 5×2 fixtures).

- [ ] **Step 10.7: Commit**

```bash
git add test/fixtures src/events/payouts src/events/index.ts
git commit -m "feat(events): handle payout.paid + add standard fixture"
```

---

## Task 11: QBO exporter + golden tests

**Files:**
- Create: `src/exporters/types.ts`
- Create: `src/exporters/qbo.ts`
- Create: `test/fixtures/test-account-maps.ts`
- Create: `test/fixtures/*.qbo.json` (5 golden files, one per fixture)
- Create: `test/exporters/qbo.spec.ts`

- [ ] **Step 11.1: Create the shared test account maps**

Create `test/fixtures/test-account-maps.ts`:

```typescript
import type { QboAccountMap, XeroAccountMap } from '../../src/exporters/types.js';
import type { AccountCode } from '../../src/accounts.js';

const codes: AccountCode[] = [
  '1000', '1010', '1100', '1200',
  '2000', '2100',
  '4000', '4100', '4900',
  '6000', '6100',
  '7000',
];

export const TEST_QBO_ACCOUNT_MAP: QboAccountMap = Object.freeze(
  Object.fromEntries(
    codes.map((c) => [c, { qboId: `qbo-${c}`, name: `QBO ${c}` }]),
  ),
) as QboAccountMap;

export const TEST_XERO_ACCOUNT_MAP: XeroAccountMap = Object.freeze(
  Object.fromEntries(codes.map((c) => [c, { accountCode: c }])),
) as XeroAccountMap;
```

- [ ] **Step 11.2: Create the exporter types file**

Create `src/exporters/types.ts`:

```typescript
import type { AccountCode } from '../accounts.js';

export type QboAccountMap = Readonly<Record<AccountCode, { qboId: string; name: string }>>;

export type XeroAccountMap = Readonly<Record<AccountCode, { accountCode: string }>>;
```

- [ ] **Step 11.3: Create the QBO golden file for `charge_succeeded_standard`**

Create `test/fixtures/charge_succeeded_standard.qbo.json`:

```json
{
  "TxnDate": "2025-01-15",
  "DocNumber": "evt_test_charge_succe",
  "PrivateNote": "Stripe charge ch_test_001 (customer cus_test_001)",
  "Line": [
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 96.80,
      "Description": "Net to Stripe balance",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-1010", "name": "QBO 1010" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 3.20,
      "Description": "Stripe processing fee",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-6000", "name": "QBO 6000" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 100.00,
      "Description": "Subscription revenue",
      "JournalEntryLineDetail": {
        "PostingType": "Credit",
        "AccountRef": { "value": "qbo-4000", "name": "QBO 4000" }
      }
    }
  ]
}
```

(`DocNumber` is `evt_test_charge_succe` — first 21 chars of `evt_test_charge_succeeded_001`. QBO's `DocNumber` cap is 21 chars; we truncate exactly to that.)

- [ ] **Step 11.4: Create the QBO golden for `charge_refunded_partial`**

Create `test/fixtures/charge_refunded_partial.qbo.json`:

```json
{
  "TxnDate": "2025-01-17",
  "DocNumber": "evt_test_charge_refun",
  "PrivateNote": "Stripe refund re_test_001 for charge ch_test_001",
  "Line": [
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 30.00,
      "Description": "Refund issued",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-4900", "name": "QBO 4900" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 30.00,
      "Description": "Refund deducted from Stripe balance",
      "JournalEntryLineDetail": {
        "PostingType": "Credit",
        "AccountRef": { "value": "qbo-1010", "name": "QBO 1010" }
      }
    }
  ]
}
```

- [ ] **Step 11.5: Create the QBO golden for `invoice_payment_succeeded_monthly`**

Create `test/fixtures/invoice_payment_succeeded_monthly.qbo.json`:

```json
{
  "TxnDate": "2025-01-15",
  "DocNumber": "evt_test_invoice_mont",
  "PrivateNote": "Stripe invoice in_test_monthly_001 (customer cus_test_monthly_001)",
  "Line": [
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 48.25,
      "Description": "Net to Stripe balance",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-1010", "name": "QBO 1010" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 1.75,
      "Description": "Stripe processing fee",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-6000", "name": "QBO 6000" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 50.00,
      "Description": "Subscription revenue (1-month period)",
      "JournalEntryLineDetail": {
        "PostingType": "Credit",
        "AccountRef": { "value": "qbo-4000", "name": "QBO 4000" }
      }
    }
  ]
}
```

- [ ] **Step 11.6: Create the QBO golden for `invoice_payment_succeeded_annual`** (cash entry only; schedule export tested separately below)

Create `test/fixtures/invoice_payment_succeeded_annual.qbo.json`:

```json
{
  "TxnDate": "2025-01-15",
  "DocNumber": "evt_test_invoice_annu",
  "PrivateNote": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001)",
  "Line": [
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 1164.00,
      "Description": "Net to Stripe balance",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-1010", "name": "QBO 1010" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 36.00,
      "Description": "Stripe processing fee",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-6000", "name": "QBO 6000" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 1200.00,
      "Description": "Annual subscription deferred",
      "JournalEntryLineDetail": {
        "PostingType": "Credit",
        "AccountRef": { "value": "qbo-2100", "name": "QBO 2100" }
      }
    }
  ]
}
```

- [ ] **Step 11.7: Create the QBO golden for `payout_paid_standard`**

Create `test/fixtures/payout_paid_standard.qbo.json`:

```json
{
  "TxnDate": "2025-01-24",
  "DocNumber": "evt_test_payout_001",
  "PrivateNote": "Stripe payout po_test_001 to ba_test_001",
  "Line": [
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 5000.00,
      "Description": "Funds arrived in bank",
      "JournalEntryLineDetail": {
        "PostingType": "Debit",
        "AccountRef": { "value": "qbo-1000", "name": "QBO 1000" }
      }
    },
    {
      "DetailType": "JournalEntryLineDetail",
      "Amount": 5000.00,
      "Description": "Funds left Stripe balance",
      "JournalEntryLineDetail": {
        "PostingType": "Credit",
        "AccountRef": { "value": "qbo-1010", "name": "QBO 1010" }
      }
    }
  ]
}
```

- [ ] **Step 11.8: Write the failing QBO exporter test**

Create `test/exporters/qbo.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapEvent } from '../../src/engine.js';
import { toQbo, toQboSchedule } from '../../src/exporters/qbo.js';
import { TEST_QBO_ACCOUNT_MAP } from '../fixtures/test-account-maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

const FIXTURES = [
  'charge_succeeded_standard',
  'charge_refunded_partial',
  'invoice_payment_succeeded_monthly',
  'invoice_payment_succeeded_annual',
  'payout_paid_standard',
];

describe('toQbo (cash entry)', () => {
  for (const name of FIXTURES) {
    it(`${name}: matches golden QBO output`, () => {
      const event = loadJson(`${name}.event.json`) as import('stripe').Stripe.Event;
      const expectedQbo = loadJson(`${name}.qbo.json`);
      const result = mapEvent(event);
      expect(result.entries.length).toBeGreaterThan(0);
      const qbo = toQbo(result.entries[0]!, TEST_QBO_ACCOUNT_MAP);
      expect(qbo).toEqual(expectedQbo);
    });
  }
});

describe('toQboSchedule', () => {
  it('invoice_payment_succeeded_annual: produces 12 future-dated QBO entries', () => {
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as import('stripe').Stripe.Event;
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toHaveLength(12);
    expect(qboEntries[0]!.TxnDate).toBe('2025-02-15');
    expect(qboEntries[11]!.TxnDate).toBe('2026-01-15');
    // Each entry must have one Debit + one Credit summing to zero net.
    for (const qbo of qboEntries) {
      expect(qbo.Line).toHaveLength(2);
      const debit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Debit');
      const credit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Credit');
      expect(debit?.Amount).toBe(100);
      expect(credit?.Amount).toBe(100);
    }
  });
});
```

- [ ] **Step 11.9: Run tests to verify failure**

Run: `pnpm test test/exporters/qbo.spec.ts`
Expected: FAIL — cannot resolve `'../../src/exporters/qbo.js'`.

- [ ] **Step 11.10: Implement `src/exporters/qbo.ts`**

```typescript
import type { JournalEntry, RecognitionSchedule, JournalLine } from '../journal.js';
import type { QboAccountMap } from './types.js';

export interface QboJournalEntry {
  TxnDate: string;
  DocNumber?: string;
  PrivateNote: string;
  Line: ReadonlyArray<QboLine>;
}

export interface QboLine {
  DetailType: 'JournalEntryLineDetail';
  Amount: number;
  Description?: string;
  JournalEntryLineDetail: {
    PostingType: 'Debit' | 'Credit';
    AccountRef: { value: string; name: string };
  };
}

const QBO_DOCNUMBER_MAX = 21;

function centsToMajor(amount: number): number {
  // Round-trip through string to avoid 0.1 + 0.2 issues; integer cents → 2-decimal float.
  return Number((amount / 100).toFixed(2));
}

function truncateDocNumber(eventId: string): string {
  return eventId.length <= QBO_DOCNUMBER_MAX ? eventId : eventId.slice(0, QBO_DOCNUMBER_MAX);
}

function lineToQbo(line: JournalLine, accountMap: QboAccountMap): QboLine {
  const ref = accountMap[line.accountCode];
  if (!ref) {
    throw new Error(`QBO accountMap missing entry for account ${line.accountCode}`);
  }
  const qboLine: QboLine = {
    DetailType: 'JournalEntryLineDetail',
    Amount: centsToMajor(line.amount),
    JournalEntryLineDetail: {
      PostingType: line.side === 'debit' ? 'Debit' : 'Credit',
      AccountRef: { value: ref.qboId, name: ref.name },
    },
  };
  if (line.memo !== undefined) qboLine.Description = line.memo;
  return qboLine;
}

export function toQbo(entry: JournalEntry, accountMap: QboAccountMap): QboJournalEntry {
  const out: QboJournalEntry = {
    TxnDate: entry.date,
    PrivateNote: entry.memo,
    Line: entry.lines.map((l) => lineToQbo(l, accountMap)),
  };
  out.DocNumber = truncateDocNumber(entry.sourceEventId);
  return out;
}

export function toQboSchedule(
  schedule: RecognitionSchedule,
  accountMap: QboAccountMap,
): QboJournalEntry[] {
  return schedule.entries.map((e) => toQbo(e, accountMap));
}
```

- [ ] **Step 11.11: Run tests to verify pass**

Run: `pnpm test test/exporters/qbo.spec.ts`
Expected: PASS, 6 tests (5 cash + 1 schedule).

- [ ] **Step 11.12: Commit**

```bash
git add src/exporters test/exporters/qbo.spec.ts test/fixtures/test-account-maps.ts test/fixtures/*.qbo.json
git commit -m "feat(exporters): add QBO JournalEntry exporter with golden tests"
```

---

## Task 12: Xero exporter + golden tests

**Files:**
- Create: `src/exporters/xero.ts`
- Create: `test/fixtures/*.xero.json` (5 golden files)
- Create: `test/exporters/xero.spec.ts`

- [ ] **Step 12.1: Create Xero golden for `charge_succeeded_standard`**

Create `test/fixtures/charge_succeeded_standard.xero.json`:

```json
{
  "Narration": "Stripe charge ch_test_001 (customer cus_test_001)",
  "Date": "2025-01-15",
  "Status": "DRAFT",
  "JournalLines": [
    { "LineAmount": 96.80, "AccountCode": "1010", "Description": "Net to Stripe balance" },
    { "LineAmount": 3.20, "AccountCode": "6000", "Description": "Stripe processing fee" },
    { "LineAmount": -100.00, "AccountCode": "4000", "Description": "Subscription revenue" }
  ]
}
```

- [ ] **Step 12.2: Create Xero golden for `charge_refunded_partial`**

Create `test/fixtures/charge_refunded_partial.xero.json`:

```json
{
  "Narration": "Stripe refund re_test_001 for charge ch_test_001",
  "Date": "2025-01-17",
  "Status": "DRAFT",
  "JournalLines": [
    { "LineAmount": 30.00, "AccountCode": "4900", "Description": "Refund issued" },
    { "LineAmount": -30.00, "AccountCode": "1010", "Description": "Refund deducted from Stripe balance" }
  ]
}
```

- [ ] **Step 12.3: Create Xero golden for `invoice_payment_succeeded_monthly`**

Create `test/fixtures/invoice_payment_succeeded_monthly.xero.json`:

```json
{
  "Narration": "Stripe invoice in_test_monthly_001 (customer cus_test_monthly_001)",
  "Date": "2025-01-15",
  "Status": "DRAFT",
  "JournalLines": [
    { "LineAmount": 48.25, "AccountCode": "1010", "Description": "Net to Stripe balance" },
    { "LineAmount": 1.75, "AccountCode": "6000", "Description": "Stripe processing fee" },
    { "LineAmount": -50.00, "AccountCode": "4000", "Description": "Subscription revenue (1-month period)" }
  ]
}
```

- [ ] **Step 12.4: Create Xero golden for `invoice_payment_succeeded_annual`**

Create `test/fixtures/invoice_payment_succeeded_annual.xero.json`:

```json
{
  "Narration": "Stripe invoice in_test_annual_001 (customer cus_test_annual_001)",
  "Date": "2025-01-15",
  "Status": "DRAFT",
  "JournalLines": [
    { "LineAmount": 1164.00, "AccountCode": "1010", "Description": "Net to Stripe balance" },
    { "LineAmount": 36.00, "AccountCode": "6000", "Description": "Stripe processing fee" },
    { "LineAmount": -1200.00, "AccountCode": "2100", "Description": "Annual subscription deferred" }
  ]
}
```

- [ ] **Step 12.5: Create Xero golden for `payout_paid_standard`**

Create `test/fixtures/payout_paid_standard.xero.json`:

```json
{
  "Narration": "Stripe payout po_test_001 to ba_test_001",
  "Date": "2025-01-24",
  "Status": "DRAFT",
  "JournalLines": [
    { "LineAmount": 5000.00, "AccountCode": "1000", "Description": "Funds arrived in bank" },
    { "LineAmount": -5000.00, "AccountCode": "1010", "Description": "Funds left Stripe balance" }
  ]
}
```

- [ ] **Step 12.6: Write the failing Xero exporter test**

Create `test/exporters/xero.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapEvent } from '../../src/engine.js';
import { toXero, toXeroSchedule } from '../../src/exporters/xero.js';
import { TEST_XERO_ACCOUNT_MAP } from '../fixtures/test-account-maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

const FIXTURES = [
  'charge_succeeded_standard',
  'charge_refunded_partial',
  'invoice_payment_succeeded_monthly',
  'invoice_payment_succeeded_annual',
  'payout_paid_standard',
];

describe('toXero (cash entry)', () => {
  for (const name of FIXTURES) {
    it(`${name}: matches golden Xero output`, () => {
      const event = loadJson(`${name}.event.json`) as import('stripe').Stripe.Event;
      const expectedXero = loadJson(`${name}.xero.json`);
      const result = mapEvent(event);
      expect(result.entries.length).toBeGreaterThan(0);
      const xero = toXero(result.entries[0]!, TEST_XERO_ACCOUNT_MAP);
      expect(xero).toEqual(expectedXero);
    });

    it(`${name}: Xero line amounts sum to zero`, () => {
      const event = loadJson(`${name}.event.json`) as import('stripe').Stripe.Event;
      const result = mapEvent(event);
      if (result.entries.length === 0) return;
      const xero = toXero(result.entries[0]!, TEST_XERO_ACCOUNT_MAP);
      const sum = xero.JournalLines.reduce((acc, l) => acc + l.LineAmount, 0);
      expect(Math.round(sum * 100)).toBe(0);
    });
  }
});

describe('toXeroSchedule', () => {
  it('invoice_payment_succeeded_annual: produces 12 future-dated Xero entries', () => {
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as import('stripe').Stripe.Event;
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toHaveLength(12);
    expect(xeroEntries[0]!.Date).toBe('2025-02-15');
    expect(xeroEntries[11]!.Date).toBe('2026-01-15');
    for (const xero of xeroEntries) {
      expect(xero.JournalLines).toHaveLength(2);
      const sum = xero.JournalLines.reduce((acc, l) => acc + l.LineAmount, 0);
      expect(Math.round(sum * 100)).toBe(0);
    }
  });
});
```

- [ ] **Step 12.7: Run tests to verify failure**

Run: `pnpm test test/exporters/xero.spec.ts`
Expected: FAIL — cannot resolve `'../../src/exporters/xero.js'`.

- [ ] **Step 12.8: Implement `src/exporters/xero.ts`**

```typescript
import type { JournalEntry, JournalLine, RecognitionSchedule } from '../journal.js';
import type { XeroAccountMap } from './types.js';

export interface XeroManualJournal {
  Narration: string;
  Date: string;
  Status: 'DRAFT' | 'POSTED';
  JournalLines: ReadonlyArray<XeroJournalLine>;
}

export interface XeroJournalLine {
  LineAmount: number; // signed: + = debit, − = credit
  AccountCode: string;
  Description?: string;
}

function centsToMajor(amount: number): number {
  return Number((amount / 100).toFixed(2));
}

function lineToXero(line: JournalLine, accountMap: XeroAccountMap): XeroJournalLine {
  const ref = accountMap[line.accountCode];
  if (!ref) {
    throw new Error(`Xero accountMap missing entry for account ${line.accountCode}`);
  }
  const signed = line.side === 'debit' ? centsToMajor(line.amount) : -centsToMajor(line.amount);
  const out: XeroJournalLine = {
    LineAmount: signed,
    AccountCode: ref.accountCode,
  };
  if (line.memo !== undefined) out.Description = line.memo;
  return out;
}

export function toXero(
  entry: JournalEntry,
  accountMap: XeroAccountMap,
  status: 'DRAFT' | 'POSTED' = 'DRAFT',
): XeroManualJournal {
  return {
    Narration: entry.memo,
    Date: entry.date,
    Status: status,
    JournalLines: entry.lines.map((l) => lineToXero(l, accountMap)),
  };
}

export function toXeroSchedule(
  schedule: RecognitionSchedule,
  accountMap: XeroAccountMap,
  status: 'DRAFT' | 'POSTED' = 'DRAFT',
): XeroManualJournal[] {
  return schedule.entries.map((e) => toXero(e, accountMap, status));
}
```

- [ ] **Step 12.9: Run tests to verify pass**

Run: `pnpm test test/exporters/xero.spec.ts`
Expected: PASS, 11 tests (5 golden + 5 zero-sum + 1 schedule).

- [ ] **Step 12.10: Commit**

```bash
git add src/exporters/xero.ts test/exporters/xero.spec.ts test/fixtures/*.xero.json
git commit -m "feat(exporters): add Xero ManualJournal exporter with golden tests"
```

---

## Task 13: Final verification — typecheck + lint + e2e:fixtures

- [ ] **Step 13.1: Run typecheck**

Run: `pnpm typecheck`
Expected: zero errors.

If errors appear:
- Most likely a `verbatimModuleSyntax` violation — change a runtime `import { Foo }` to `import type { Foo }` for any type-only imports.
- If `Stripe.Event` discriminated-union narrowing complains, ensure each handler casts `event.data.object as Stripe.Charge` (etc.) right after the `event.type` guard.

- [ ] **Step 13.2: Run lint**

Run: `pnpm lint`
Expected: zero errors.

Likely fixes if errors appear:
- `@typescript-eslint/no-non-null-assertion` on `result.entries[0]!` — replace with `result.entries[0] ?? throw new Error(...)` or check length first.
- `@typescript-eslint/explicit-function-return-type` — add explicit return types where missing.

- [ ] **Step 13.3: Run the full test suite**

Run: `pnpm test`
Expected: ALL PASS.
- `test/money.spec.ts`: 7 tests
- `test/accounts.spec.ts`: 7 tests
- `test/journal.spec.ts`: 7 tests
- `test/engine.spec.ts`: 11 tests (1 unknown + 5×2)
- `test/exporters/qbo.spec.ts`: 6 tests
- `test/exporters/xero.spec.ts`: 11 tests

Total: ~49 tests.

- [ ] **Step 13.4: Run the e2e:fixtures script**

Run: `pnpm e2e:fixtures`
Expected: PASS — all engine + exporter tests run with verbose reporter.

- [ ] **Step 13.5: Commit any final adjustments**

If any small fixes were needed:

```bash
git add -A
git commit -m "chore: address final typecheck/lint nits"
```

If no fixes were needed, skip this step.

- [ ] **Step 13.6: Update ai-sync handoff**

Run (from project root):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\.ai-sync\ai-sync.ps1" -Action handoff -Agent claude -Summary "Implemented ledgerly engine MVP: money/accounts/journal/engine + 5 handlers + QBO/Xero exporters with golden tests" -FilesChanged "src/, test/, package.json, tsconfig.json, vitest.config.ts" -TestsRun "pnpm test (~49 pass), pnpm typecheck, pnpm lint, pnpm e2e:fixtures" -Blockers "none" -NextSteps "Run /goal loop to expand to full ~50 fixture set per spec section 6"
```

---

## Verification at end of plan

The engine now satisfies these spec invariants:

- Every emitted entry is balanced (`checkBalance(entry).balanced === true`) — enforced by `assertBalanced` in `mapEvent`, doubled by per-fixture explicit assertions in `test/engine.spec.ts`.
- Every entry has a non-empty `memo` and `sourceEventId` of form `evt_*` — guaranteed by handler construction; visible in every fixture's `expected.json`.
- Every `accountCode` is in the `AccountCode` union (compile-time) and `ACCOUNTS` (runtime via `test/accounts.spec.ts`).
- All `Cents` values are integers — enforced by `cents()` constructor.
- QBO output: every entry's `Line[]` debit sum equals credit sum — implicit via the journal balance invariant + correct major-unit conversion; covered by golden tests.
- Xero output: every entry's `JournalLines[]` `LineAmount` sum equals zero — explicitly checked in `test/exporters/xero.spec.ts`.
- Same event input → byte-identical JSON output across runs — guaranteed by `sortLines` + pure functions + frozen account maps.

The five starter fixtures from spec build-order step 6 are green: `charge_succeeded_standard`, `charge_refunded_partial`, `invoice_payment_succeeded_monthly`, `invoice_payment_succeeded_annual` (with full 12-entry recognition schedule), `payout_paid_standard`.

The `/goal` exit condition for the full ~50-fixture expansion remains the next phase.
