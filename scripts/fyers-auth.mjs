#!/usr/bin/env node
/**
 * Exchange a Fyers auth code for an access token and save it.
 *
 *   node scripts/fyers-auth.mjs <auth_code>
 *
 * The auth code comes from the Fyers consent screen — it is a JWT whose `sub`
 * is "auth_code". It is single-use and expires about 8 hours after issue, so
 * exchange it promptly.
 *
 * Fyers has disabled the refresh-token API (SEBI), so this is the only way to
 * renew: generate a new auth code, then run this again.
 */

import { exchangeAuthCode, fyersTokenInfo } from '../src/fyersClient.js';

const authCode = process.argv[2];
if (!authCode) {
  console.error('usage: node scripts/fyers-auth.mjs <auth_code>');
  process.exit(2);
}

if (authCode.split('.').length !== 3) {
  console.error('that does not look like a Fyers auth code (expected a JWT with 3 dot-separated parts)');
  process.exit(2);
}

try {
  await exchangeAuthCode(authCode);
  console.log('OK — Fyers token saved');
  console.log(JSON.stringify(fyersTokenInfo(), null, 2));
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
