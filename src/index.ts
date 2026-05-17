// Public API for ledgerly. Internal helpers are NOT re-exported.

// Core engine
export { mapEvent } from './engine.js';
export {
  UnhandledEventError,
  MissingExpansionError,
  requireExpanded,
} from './errors.js';

// Money
export { cents, ZERO_CENTS } from './money.js';
export type { Cents } from './money.js';

// Accounts
export { ACCOUNTS } from './accounts.js';
export type { AccountCode, AccountType, AccountDef, PostingSide } from './accounts.js';

// Journal types and validators
export { checkBalance, assertBalanced } from './journal.js';
export type {
  JournalLine,
  JournalEntry,
  RecognitionSchedule,
  MapResult,
  BalanceReport,
} from './journal.js';

// Exporters
export { toQbo, toQboSchedule } from './exporters/qbo.js';
export type { QboJournalEntry, QboLine } from './exporters/qbo.js';
export { toXero, toXeroSchedule } from './exporters/xero.js';
export type { XeroManualJournal, XeroJournalLine } from './exporters/xero.js';
export type { QboAccountMap, XeroAccountMap } from './exporters/types.js';
