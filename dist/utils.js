"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.nowString = nowString;
exports.nowIso = nowIso;
exports.normalizeStatus = normalizeStatus;
exports.normalizePhone = normalizePhone;
exports.isValidPhone = isValidPhone;
exports.escapeRsc = escapeRsc;
exports.makeOrderReference = makeOrderReference;
exports.generateVoucherCode = generateVoucherCode;
/** ISO timestamp string with explicit UTC indicator so new Date() always parses correctly */
function nowString() {
    return new Date().toISOString().slice(0, 19) + 'Z';
}
/** Full ISO timestamp */
function nowIso() {
    return new Date().toISOString();
}
/** Normalize payment status strings to canonical values */
function normalizeStatus(status) {
    const s = String(status || '').trim().toUpperCase();
    if (['SUCCESS', 'SETTLED', 'PAID', 'COMPLETED', 'APPROVED'].includes(s))
        return 'SUCCESS';
    if (['FAILED', 'FAIL', 'DECLINED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(s))
        return 'FAILED';
    return 'PROCESSING';
}
/** Normalize phone number to 255 format */
function normalizePhone(phone) {
    let p = String(phone || '').replace(/\D/g, '');
    if (p.startsWith('0'))
        p = '255' + p.slice(1);
    return p;
}
/** Validate Tanzanian phone number (2556x, 2557x, 2558x, 2559x) */
function isValidPhone(phone) {
    return /^255[6-9]\d{8}$/.test(normalizePhone(phone));
}
/** Escape a string for use in RouterOS .rsc script */
function escapeRsc(v) {
    return String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
/** Generate a unique order reference */
function makeOrderReference() {
    return (`HP${Date.now().toString(36)}${Math.floor(Math.random() * 999).toString(36)}`).toUpperCase();
}
/** Generate a 6-char voucher code (no I/O to avoid confusion with 1/l) */
function generateVoucherCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++)
        out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}
/** Logger — structured, with levels. Falls back to console in non-production. */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
function log(level, context, message, meta) {
    if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel])
        return;
    const timestamp = nowIso();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${context}]`;
    const line = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;
    if (level === 'error')
        console.error(line);
    else if (level === 'warn')
        console.warn(line);
    else
        console.log(line);
}
exports.logger = {
    debug: (ctx, msg, meta) => log('debug', ctx, msg, meta),
    info: (ctx, msg, meta) => log('info', ctx, msg, meta),
    warn: (ctx, msg, meta) => log('warn', ctx, msg, meta),
    error: (ctx, msg, meta) => log('error', ctx, msg, meta),
};
//# sourceMappingURL=utils.js.map