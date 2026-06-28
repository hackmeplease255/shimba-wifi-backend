import dotenv from 'dotenv';
dotenv.config({ override: true });

import path from 'path';

export const config = {
  /** Server port — single clean env var */
  port: Number(process.env.PORT || 22896),

  /** Public base URL for webhook callbacks */
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ||
    `https://shimbawifi.xyz`
  ).replace(/\/+$/, ''),

  /** Database path */
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'shimba.db'),

  /** Migrate from data.json on first run */
  migrateFromJson: process.env.MIGRATE_FROM_JSON || path.join(__dirname, '..', 'data.json'),

  /* ── Mongike Payment Gateway ── */
  mongike: {
    baseUrl: process.env.MONGIKE_BASE_URL || 'https://mongike.com',
    apiKey: process.env.MONGIKE_API_KEY || '',
    paymentEndpoint: process.env.MONGIKE_PAYMENT_ENDPOINT || '/api/v1/payments/mobile-money/tanzania',
  },

  /* ── MikroTik Router ── */
  mikrotik: {
    host: process.env.MIKROTIK_IP || '192.168.88.1',
    port: Number(process.env.MIKROTIK_PORT || 8728),
    user: process.env.MIKROTIK_USER || 'admin',
    password: process.env.MIKROTIK_PASS || '',
    /** How many times to retry a failed command */
    retries: 3,
    /** Timeout per connection attempt (ms) */
    timeout: 10_000,
  },

  /* ── Sync ── */
  syncToken: process.env.SYNC_TOKEN || 'mysecret123',

  /* ── Admin Credentials (for Basic Auth fallback) ── */
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
  },

  /* ── JWT Auth (for token-based admin API) ── */
  jwt: {
    secret: process.env.JWT_SECRET || process.env.SYNC_TOKEN || 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  /* ── SMS ── */
  sms: {
    enabled: String(process.env.SMS_ENABLED || 'false').toLowerCase() === 'true',
    provider: String(process.env.SMS_PROVIDER || 'generic').toLowerCase(),
    apiUrl: process.env.SMS_API_URL || '',
    apiKey: process.env.SMS_API_KEY || '',
    bearerToken: process.env.SMS_BEARER_TOKEN || '',
    authHeader: process.env.SMS_AUTH_HEADER || '',
    sender: process.env.SMS_SENDER || 'SHIMBA',
  },

  /* ── Packages ── */
  packages: {
    '6hours': { label: '6 Hours', amount: 500, mikrotik_profile: '6hours-500', limit_uptime: '6h' } as const,
    '24hours': { label: '24 Hours', amount: 1000, mikrotik_profile: '24hours-1000', limit_uptime: '1d' } as const,
    '48hours': { label: '48 Hours', amount: 2000, mikrotik_profile: '48hours-2000', limit_uptime: '2d' } as const,
    '7days': { label: '7 Days', amount: 5000, mikrotik_profile: '7days-5000', limit_uptime: '1w' } as const,
  } as const,

  /** Hotspot files served by MikroTik */
  hotspotFiles: new Set([
    'login.html', 'alogin.html', 'rlogin.html',
    'redirect.html', 'logout.html', 'status.html', 'error.html',
  ]),

  /** Data retention (days) */
  dataRetentionDays: 30,
};

export type PackageId = keyof typeof config.packages;
export type PackageDef = (typeof config.packages)[PackageId];

export function isValidPackage(id: string): id is PackageId {
  return id in config.packages;
}

export function getPackage(id: string): PackageDef | undefined {
  return config.packages[id as PackageId];
}
