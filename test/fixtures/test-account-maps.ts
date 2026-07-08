import type { QboAccountMap, XeroAccountMap } from '../../src/exporters/types.js';
import type { AccountCode } from '../../src/accounts.js';

const codes: AccountCode[] = [
  '1000', '1010', '1100', '1200',
  '2000', '2100', '2200',
  '4000', '4100', '4900',
  '6000', '6100', '6200',
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
