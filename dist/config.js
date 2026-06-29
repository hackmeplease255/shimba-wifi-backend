"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.isValidPackage = isValidPackage;
exports.getPackage = getPackage;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config({ override: true });
const path_1 = __importDefault(require("path"));
exports.config = {
    /** Server port — single clean env var */
    port: Number(process.env.PORT || 22896),
    /** Public base URL for webhook callbacks */
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ||
        `https://shimbawifi.xyz`).replace(/\/+$/, ''),
    /** Database path */
    dbPath: process.env.DB_PATH || path_1.default.join(__dirname, '..', 'data', 'shimba.db'),
    /** Migrate from data.json on first run */
    migrateFromJson: process.env.MIGRATE_FROM_JSON || path_1.default.join(__dirname, '..', 'data.json'),
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
        '6hours': { label: '6 Hours', amount: 500, mikrotik_profile: '6hours-500', limit_uptime: '6h' },
        '24hours': { label: '24 Hours', amount: 1000, mikrotik_profile: '24hours-1000', limit_uptime: '1d' },
        '48hours': { label: '48 Hours', amount: 2000, mikrotik_profile: '48hours-2000', limit_uptime: '2d' },
        '7days': { label: '7 Days', amount: 5000, mikrotik_profile: '7days-5000', limit_uptime: '1w' },
    },
    /** Hotspot files served by MikroTik */
    hotspotFiles: new Set([
        'login.html', 'alogin.html', 'rlogin.html',
        'redirect.html', 'logout.html', 'status.html', 'error.html',
        'fix-onlogin.rsc',
    ]),
    /** Data retention (days) */
    dataRetentionDays: 30,
};
function isValidPackage(id) {
    return id in exports.config.packages;
}
function getPackage(id) {
    return exports.config.packages[id];
}
//# sourceMappingURL=config.js.map