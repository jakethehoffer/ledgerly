import type { AccountCode } from '../accounts.js';

export type QboAccountMap = Readonly<Record<AccountCode, { qboId: string; name: string }>>;

export type XeroAccountMap = Readonly<Record<AccountCode, { accountCode: string }>>;
