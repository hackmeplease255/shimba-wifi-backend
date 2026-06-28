/**
 * Shared utility functions for SHIMBA WiFi backend.
 */
import crypto from 'crypto';

/** ISO timestamp string with explicit UTC indicator so new Date() always parses correctly */
export function nowString(): string {
  return new Date().toISOString().slice(0, 19) + 'Z';
}

/** Full ISO timestamp */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalize payment status strings to canonical values */
export function normalizeStatus(status: string): 'SUCCESS' | 'FAILED' | 'PROCESSING' {
  const s = String(status || '').trim().toUpperCase();
  if (['SUCCESS', 'SETTLED', 'PAID', 'COMPLETED', 'APPROVED'].includes(s)) return 'SUCCESS';
  if (['FAILED', 'FAIL', 'DECLINED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED'].includes(s)) return 'FAILED';
  return 'PROCESSING';
}

/** Normalize phone number to 255 format */
export function normalizePhone(phone: string): string {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) p = '255' + p.slice(1);
  return p;
}

/** Validate Tanzanian phone number (2556x, 2557x, 2558x, 2559x) */
export function isValidPhone(phone: string): boolean {
  return /^255[6-9]\d{8}$/.test(normalizePhone(phone));
}

/** Escape a string for use in RouterOS .rsc script */
export function escapeRsc(v: string): string {
  return String(v || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Generate a unique order reference */
export function makeOrderReference(): string {
  return (`HP${Date.now().toString(36)}${Math.floor(Math.random() * 999).toString(36)}`).toUpperCase();
}

/** Generate a 6-char voucher code (no I/O to avoid confusion with 1/l) */
export function generateVoucherCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Logger — structured, with levels. Falls back to console in non-production. */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

function log(level: LogLevel, context: string, message: string, meta?: unknown): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;
  const timestamp = nowIso();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${context}]`;
  const line = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (ctx: string, msg: string, meta?: unknown) => log('debug', ctx, msg, meta),
  info: (ctx: string, msg: string, meta?: unknown) => log('info', ctx, msg, meta),
  warn: (ctx: string, msg: string, meta?: unknown) => log('warn', ctx, msg, meta),
  error: (ctx: string, msg: string, meta?: unknown) => log('error', ctx, msg, meta),
};
