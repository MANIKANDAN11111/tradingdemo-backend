import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load server/.env regardless of the process working directory.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export const config = {
  apiKey: process.env.GROWW_API_KEY || '',
  apiSecret: process.env.GROWW_API_SECRET || '',
  baseUrl: (process.env.GROWW_API_BASE_URL || 'https://api.groww.in/v1').replace(/\/$/, ''),
  port: Number(process.env.PORT || 5000),
  totpSecret: process.env.GROWW_TOTP_SECRET || '',
  totpToken: process.env.GROWW_TOTP_KEY || '',
  apiVersion: process.env.GROWW_API_VERSION || '1.0',

  // Fyers API credentials
  fyersAppId: process.env.FYERS_APP_ID || '',
  fyersAppSecret: process.env.FYERS_APP_SECRET || '',
  fyersRedirectUri: process.env.FYERS_REDIRECT_URI || 'https://trade.fyers.in/api-login/redirect-uri/index.html',

  // CoinSwitch PRO API
  coinSwitchSecret: process.env.COINSWITCH_SECRET || '',
  coinSwitchBaseUrl: (process.env.COINSWITCH_BASE_URL || 'https://coinswitch.co').replace(/\/$/, ''),

  // Session signing secret for the dashboard login gate
  authSecret: process.env.AUTH_SECRET || '',

  // PostgreSQL connection for the user store
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://tradingdemo:***@127.0.0.1:5433/tradingdemo',
};

export const fyersConfig = {
  appId: process.env.FYERS_APP_ID || '',
  appSecret: process.env.FYERS_APP_SECRET || '',
  redirectUri: process.env.FYERS_REDIRECT_URI || 'http://localhost:5000/api/fyers/callback',
};

export function assertCredentials() {
  const missing = [];
  if (!config.apiKey) missing.push('GROWW_API_KEY');
  if (!config.apiSecret) missing.push('GROWW_API_SECRET');
  if (missing.length) {
    throw new Error(
      `Missing credentials: ${missing.join(', ')}. Copy server/.env.example to server/.env and fill them in.`
    );
  }
}
