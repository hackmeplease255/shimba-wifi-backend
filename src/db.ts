/**
 * SQLite database layer for SHIMBA WiFi.
 * Uses sql.js — a pure-JavaScript SQLite implementation that requires NO native compilation.
 * Perfect for Bot Hosting / Pterodactyl environments where node-gyp may fail.
 *
 * IMPORTANT: sql.js does NOT auto-persist. We manually save the DB to disk
 * after every write operation, with debouncing to batch rapid writes.
 */
import initSqlJs, { Database as SqlJsDatabase, SqlJsStatic } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { nowString, nowIso, normalizePhone, parseLimitUptime, logger } from './utils';

/* ── Type Definitions ── */

export interface PaymentOrder {
  id: number;
  order_reference: string;
  phone: string;
  package_name: string;
  amount: number;
  status: string;
  voucher_code: string | null;
  sms_sent: boolean;
  sms_provider: string | null;
  sms_status: string | null;
  paid_at: string | null;
  error: string | null;
  mongike_ref: string | null;
  status_detail: string | null;
  created_at: string;
  updated_at: string;
}

export interface Voucher {
  id: number;
  code: string;
  phone: string;
  package_name: string;
  amount: number;
  mikrotik_profile: string;
  limit_uptime: string;
  order_reference: string;
  synced: boolean;
  synced_at: string | null;
  sms_sent: boolean;
  sms_provider: string | null;
  sms_status: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SmsLog {
  id: number;
  phone: string;
  code: string;
  order_reference: string;
  sent: boolean;
  provider: string;
  response: string;
  created_at: string;
}

export interface ActiveUser {
  id: number;
  user: string;
  code: string;
  mac: string;
  ip: string;
  package_name: string | null;
  login_at: string;
  last_event: string;
  updated_at: string;
  bytes_in: number;
  bytes_out: number;
}

export interface WebhookEvent {
  id: number;
  order_reference: string;
  raw_body: string;
  status: string;
  created_at: string;
}

/* ── Database Singleton ── */

let SQL: SqlJsStatic | null = null;
let _db: SqlJsDatabase | null = null;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Get or initialize the database */
export function getDb(): SqlJsDatabase {
  if (_db) return _db;
  throw new Error('Database not initialized. Call initDb() first.');
}

/** Initialize the database (async — must be called before anything else) */
export async function initDb(): Promise<void> {
  SQL = await initSqlJs();

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(config.dbPath)) {
    const buffer = fs.readFileSync(config.dbPath);
    _db = new SQL.Database(buffer);
    logger.info('DB', `Loaded existing database (${buffer.length} bytes)`);
  } else {
    _db = new SQL.Database();
    logger.info('DB', 'Created new database');
  }

  initTables();  // Tables created + debounced save scheduled
}

/** Force-save the database to disk immediately */
export function saveDb(): void {
  if (!_db) return;
  try {
    const data = _db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(config.dbPath, buffer);
  } catch (err) {
    logger.error('DB', 'Failed to save database', { error: err });
  }
}

/** Debounced save — batches rapid writes */
function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveDb();
    _saveTimer = null;
  }, 200); // 200ms debounce
}

/** Close the database */
export function closeDb(): void {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  if (_db) {
    saveDb(); // Final save
    _db.close();
    _db = null;
  }
}

/* ── Helper: run a query and return all rows as objects ── */
export function queryAll(sql: string, params: any[] = []): any[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** Helper: run a query and return the first row, or undefined */
function queryOne(sql: string, params: any[] = []): any | undefined {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

/** Helper: run an INSERT/UPDATE/DELETE */
export function run(sql: string, params: any[] = []): void {
  const db = getDb();
  db.run(sql, params);
  scheduleSave();
}

/** Helper: convert sql.js row (which may use 0/1 for booleans) to our TS types */
function toBool(val: any): boolean {
  return val === 1 || val === true || val === '1';
}

/* ── Table Initialization ── */

function initTables(): void {
  const db = getDb();

  // Note: sql.js is an in-memory SQLite implementation — PRAGMA options like WAL
  // are accepted but don't persist across restarts. This is fine for our use case.
  try { db.run('PRAGMA journal_mode=MEMORY'); } catch { /* pragma not critical */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_reference TEXT    NOT NULL UNIQUE,
      phone           TEXT    NOT NULL,
      package_name    TEXT    NOT NULL,
      amount          INTEGER NOT NULL DEFAULT 0,
      status          TEXT    NOT NULL DEFAULT 'PROCESSING',
      voucher_code    TEXT,
      sms_sent        INTEGER NOT NULL DEFAULT 0,
      sms_provider    TEXT,
      sms_status      TEXT,
      paid_at         TEXT,
      error           TEXT,
      mongike_ref     TEXT,
      status_detail   TEXT,
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      code             TEXT    NOT NULL UNIQUE,
      phone            TEXT    NOT NULL,
      package_name     TEXT    NOT NULL,
      amount           INTEGER NOT NULL DEFAULT 0,
      mikrotik_profile TEXT,
      limit_uptime     TEXT,
      order_reference  TEXT    NOT NULL,
      synced           INTEGER NOT NULL DEFAULT 0,
      synced_at        TEXT,
      sms_sent         INTEGER NOT NULL DEFAULT 0,
      sms_provider     TEXT,
      sms_status       TEXT,
      status           TEXT    NOT NULL DEFAULT 'issued',
      created_at       TEXT    NOT NULL,
      updated_at       TEXT    NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sms_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      phone           TEXT    NOT NULL,
      code            TEXT,
      order_reference TEXT,
      sent            INTEGER NOT NULL DEFAULT 0,
      provider        TEXT,
      response        TEXT,
      created_at      TEXT    NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS active_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user          TEXT NOT NULL,
      code          TEXT,
      mac           TEXT,
      ip            TEXT,
      package_name  TEXT,
      login_at      TEXT,
      last_event    TEXT,
      updated_at    TEXT NOT NULL,
      bytes_in      INTEGER NOT NULL DEFAULT 0,
      bytes_out     INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migrate existing databases: add bytes columns if missing
  try { db.run('ALTER TABLE active_users ADD COLUMN bytes_in INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
  try { db.run('ALTER TABLE active_users ADD COLUMN bytes_out INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }

  // Usage logs table (daily per-user bandwidth tracking)
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_usage (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      code      TEXT NOT NULL,
      phone     TEXT DEFAULT '',
      date      TEXT NOT NULL,
      bytes_in  INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      UNIQUE(code, date)
    );
  `);
  try { db.run('CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date)'); } catch { /* ignore */ }

  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_reference TEXT,
      raw_body        TEXT,
      status          TEXT,
      created_at      TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Create indexes (IF NOT EXISTS only works in newer SQLite — use try/catch)
  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_orders_reference ON payment_orders(order_reference)',
    'CREATE INDEX IF NOT EXISTS idx_orders_phone ON payment_orders(phone)',
    'CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code)',
    'CREATE INDEX IF NOT EXISTS idx_vouchers_phone ON vouchers(phone)',
    'CREATE INDEX IF NOT EXISTS idx_active_users_mac ON active_users(mac)',
  ];
  for (const idx of indexes) {
    try { db.run(idx); } catch { /* index already exists */ }
  }

  scheduleSave();
  logger.info('DB', 'Tables initialized');
}

/* ── Row mapping helpers ── */

function mapOrder(row: any): PaymentOrder {
  return row ? { ...row, sms_sent: toBool(row.sms_sent) } : row;
}

function mapVoucher(row: any): Voucher {
  return row ? { ...row, synced: toBool(row.synced), sms_sent: toBool(row.sms_sent) } : row;
}

function mapSmsLog(row: any): SmsLog {
  return row ? { ...row, sent: toBool(row.sent) } : row;
}

/* ── Payment Orders ── */

export function findOrderByReference(ref: string): PaymentOrder | undefined {
  return mapOrder(queryOne('SELECT * FROM payment_orders WHERE order_reference = ?', [ref]));
}

export function findOrdersByPhone(phone: string, packageName?: string): PaymentOrder[] {
  const normalized = normalizePhone(phone);
  if (packageName) {
    return queryAll(
      'SELECT * FROM payment_orders WHERE phone = ? AND package_name = ? ORDER BY id DESC',
      [normalized, packageName]
    ).map(mapOrder);
  }
  return queryAll(
    'SELECT * FROM payment_orders WHERE phone = ? ORDER BY id DESC',
    [normalized]
  ).map(mapOrder);
}

export function createOrder(ref: string, phone: string, pkgName: string, amount: number): PaymentOrder {
  const now = nowString();
  run(
    `INSERT INTO payment_orders (order_reference, phone, package_name, amount, status, sms_sent, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PROCESSING', 0, ?, ?)`,
    [ref, normalizePhone(phone), pkgName, amount, now, now]
  );
  return findOrderByReference(ref)!;
}

export function updateOrderStatus(ref: string, status: string, detail?: string, errorMsg?: string): void {
  run(
    'UPDATE payment_orders SET status = ?, status_detail = ?, error = ?, updated_at = ? WHERE order_reference = ?',
    [status, detail || null, errorMsg || null, nowString(), ref]
  );
}

export function updateOrderVoucher(ref: string, voucherCode: string, paidAt: string): void {
  run(
    `UPDATE payment_orders SET voucher_code = ?, paid_at = ?, status = 'SUCCESS', status_detail = 'voucher_issued', updated_at = ?
     WHERE order_reference = ?`,
    [voucherCode, paidAt, nowString(), ref]
  );
}

export function updateOrderSmsStatus(ref: string, sent: boolean, provider: string, smsStatus: string): void {
  run(
    'UPDATE payment_orders SET sms_sent = ?, sms_provider = ?, sms_status = ?, updated_at = ? WHERE order_reference = ?',
    [sent ? 1 : 0, provider, smsStatus, nowString(), ref]
  );
}

export function getAllOrders(limit = 300): PaymentOrder[] {
  return queryAll('SELECT * FROM payment_orders ORDER BY id DESC LIMIT ?', [limit]).map(mapOrder);
}

/* ── Vouchers ── */

export function findVoucherByCode(code: string): Voucher | undefined {
  return mapVoucher(queryOne('SELECT * FROM vouchers WHERE code = ?', [code.toUpperCase()]));
}

export function createVoucher(
  code: string, phone: string, pkgName: string, amount: number,
  mikrotikProfile: string, limitUptime: string, orderRef: string
): Voucher {
  const now = nowString();
  run(
    `INSERT INTO vouchers (code, phone, package_name, amount, mikrotik_profile, limit_uptime, order_reference, synced, sms_sent, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'issued', ?, ?)`,
    [code.toUpperCase(), normalizePhone(phone), pkgName, amount, mikrotikProfile, limitUptime, orderRef, now, now]
  );
  return findVoucherByCode(code)!;
}

export function markVoucherSynced(code: string): void {
  run('UPDATE vouchers SET synced = 1, synced_at = ?, updated_at = ? WHERE code = ?',
    [nowString(), nowString(), code.toUpperCase()]);
}

export function updateVoucherSmsStatus(code: string, sent: boolean, provider: string, smsStatus: string): void {
  run(
    'UPDATE vouchers SET sms_sent = ?, sms_provider = ?, sms_status = ?, updated_at = ? WHERE code = ?',
    [sent ? 1 : 0, provider, smsStatus, nowString(), code.toUpperCase()]
  );
}

export function getRecentVouchers(days = 30): Voucher[] {
  const rows = queryAll('SELECT * FROM vouchers ORDER BY id DESC', []);
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  return rows
    .map(mapVoucher)
    .filter(v => new Date(v.created_at).getTime() >= cutoff || new Date(v.updated_at).getTime() >= cutoff);
}

/* ── SMS Logs ── */

export function logSms(phone: string, code: string, orderRef: string, sent: boolean, provider: string, response: string): void {
  run(
    'INSERT INTO sms_logs (phone, code, order_reference, sent, provider, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [normalizePhone(phone), code, orderRef, sent ? 1 : 0, provider, response, nowString()]
  );
}

/* ── Active Users ── */

export function upsertActiveUser(userName: string, code: string, mac: string, ip: string, packageName: string | null, bytesIn?: number, bytesOut?: number): void {
  const existing = queryOne('SELECT * FROM active_users WHERE user = ?', [userName]);
  const now = nowString();
  const isoNow = nowIso();
  const bIn = bytesIn ?? 0;
  const bOut = bytesOut ?? 0;

  // Log delta bytes if this is an update with bytes data
  if (existing && (bIn > 0 || bOut > 0)) {
    const oldIn = Number(existing.bytes_in) || 0;
    const oldOut = Number(existing.bytes_out) || 0;
    const deltaIn = Math.max(0, bIn - oldIn);
    const deltaOut = Math.max(0, bOut - oldOut);
    if (deltaIn > 0 || deltaOut > 0) {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const phone = existing.code ? (findVoucherByCode(existing.code)?.phone || '') : '';
      run(
        `INSERT INTO daily_usage (code, phone, date, bytes_in, bytes_out)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(code, date) DO UPDATE SET bytes_in = bytes_in + ?, bytes_out = bytes_out + ?`,
        [userName, phone, today, deltaIn, deltaOut, deltaIn, deltaOut]
      );
    }
  }

  if (existing) {
    run(
      `UPDATE active_users SET code = ?, mac = ?, ip = ?, package_name = ?, login_at = ?, last_event = 'login', updated_at = ?, bytes_in = ?, bytes_out = ?
       WHERE user = ?`,
      [code, mac, ip, packageName, isoNow, now, bIn, bOut, userName]
    );
  } else {
    run(
      `INSERT INTO active_users (user, code, mac, ip, package_name, login_at, last_event, updated_at, bytes_in, bytes_out)
       VALUES (?, ?, ?, ?, ?, ?, 'login', ?, ?, ?)`,
      [userName, code, mac, ip, packageName, isoNow, now, bIn, bOut]
    );
  }
}

/* ── Daily Usage (bandwidth tracking) ── */

interface DailyUsage {
  date: string;
  bytes_in: number;
  bytes_out: number;
}

/** Get usage by day for the last N days */
export function getUsageByDay(days = 14): DailyUsage[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return queryAll(
    `SELECT date, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out
     FROM daily_usage WHERE date >= ?
     GROUP BY date ORDER BY date ASC`,
    [cutoff]
  ).map((r: any) => ({
    date: r.date,
    bytes_in: Number(r.bytes_in) || 0,
    bytes_out: Number(r.bytes_out) || 0,
  }));
}

/** Get usage by week for the last N weeks */
export function getUsageByWeek(weeks = 12): { week: string; bytes_in: number; bytes_out: number }[] {
  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return queryAll(
    `SELECT strftime('%Y-W%W', date) as week, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out
     FROM daily_usage WHERE date >= ?
     GROUP BY week ORDER BY week ASC`,
    [cutoff]
  ).map((r: any) => ({
    week: r.week,
    bytes_in: Number(r.bytes_in) || 0,
    bytes_out: Number(r.bytes_out) || 0,
  }));
}

/** Get usage by month for the last N months */
export function getUsageByMonth(months = 12): { month: string; bytes_in: number; bytes_out: number }[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const isoCutoff = cutoff.toISOString().slice(0, 10);
  return queryAll(
    `SELECT strftime('%Y-%m', date) as month, SUM(bytes_in) as bytes_in, SUM(bytes_out) as bytes_out
     FROM daily_usage WHERE date >= ?
     GROUP BY month ORDER BY month ASC`,
    [isoCutoff]
  ).map((r: any) => ({
    month: r.month,
    bytes_in: Number(r.bytes_in) || 0,
    bytes_out: Number(r.bytes_out) || 0,
  }));
}

/** Get total usage all-time */
export function getTotalUsage(): { bytes_in: number; bytes_out: number } {
  const row = queryOne('SELECT COALESCE(SUM(bytes_in),0) as bytes_in, COALESCE(SUM(bytes_out),0) as bytes_out FROM daily_usage');
  return { bytes_in: Number(row?.bytes_in) || 0, bytes_out: Number(row?.bytes_out) || 0 };
}

/** Cleanup old usage data (older than retentionDays) */
export function cleanupOldUsage(retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const before = (queryOne('SELECT COUNT(*) as c FROM daily_usage')?.c) || 0;
  run('DELETE FROM daily_usage WHERE date < ?', [cutoff]);
  const after = (queryOne('SELECT COUNT(*) as c FROM daily_usage')?.c) || 0;
  const removed = before - after;
  if (removed > 0) {
    logger.info('Cleanup', `Removed ${removed} usage log entries older than ${retentionDays} days`);
  }
}

export function findActiveUser(code: string, mac?: string, ip?: string): ActiveUser | undefined {
  const rows = queryAll('SELECT * FROM active_users WHERE code = ?', [code.toUpperCase()]);
  const freshAfter = Date.now() - (2 * 60 * 1000);
  return rows.find(a => {
    const loginAt = a.login_at ? new Date(a.login_at).getTime() : 0;
    const sameMac = !mac || String(a.mac || '').toUpperCase() === mac.toUpperCase();
    const sameIp = !ip || String(a.ip || '') === ip;
    return loginAt >= freshAfter && sameMac && sameIp;
  });
}

/* ── Webhook Events ── */

export function logWebhookEvent(orderRef: string, rawBody: string, status: string): void {
  run(
    'INSERT INTO webhook_events (order_reference, raw_body, status, created_at) VALUES (?, ?, ?, ?)',
    [orderRef, rawBody, status, nowString()]
  );
}

/* ── Pending Disconnects (for RSC-based MikroTik removal) ── */

/** Add a user code to the pending disconnect queue */
export function addPendingDisconnect(code: string): void {
  run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [`pending_disconnect_${code}`, code]
  );
  logger.info('DB', `Added pending disconnect for ${code}`);
}

/** Get all pending disconnect codes */
export function getPendingDisconnects(): string[] {
  const rows = queryAll("SELECT key, value FROM settings WHERE key LIKE 'pending_disconnect_%'");
  return rows.map(r => r.value).filter(Boolean);
}

/** Remove a pending disconnect (after it's been processed) */
export function removePendingDisconnect(code: string): void {
  run('DELETE FROM settings WHERE key = ?', [`pending_disconnect_${code}`]);
}

/** Clear all pending disconnects */
export function clearPendingDisconnects(): void {
  run("DELETE FROM settings WHERE key LIKE 'pending_disconnect_%'");
}

/* ── Stats ── */

export function getStats(): {
  totalOrders: number; paidOrders: number; pendingOrders: number;
  failedOrders: number; totalMoney: number; weekMoney: number;
} {
  const totalOrders = (queryOne('SELECT COUNT(*) as c FROM payment_orders')?.c) || 0;
  const paidOrders = (queryOne('SELECT COUNT(*) as c FROM payment_orders WHERE voucher_code IS NOT NULL')?.c) || 0;
  const pendingOrders = (queryOne("SELECT COUNT(*) as c FROM payment_orders WHERE status IN ('PROCESSING','PENDING')")?.c) || 0;
  const failedOrders = (queryOne("SELECT COUNT(*) as c FROM payment_orders WHERE status LIKE '%FAIL%'")?.c) || 0;
  const totalMoney = (queryOne('SELECT COALESCE(SUM(amount),0) as s FROM payment_orders WHERE voucher_code IS NOT NULL')?.s) || 0;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekMoney = (queryOne('SELECT COALESCE(SUM(amount),0) as s FROM payment_orders WHERE voucher_code IS NOT NULL AND paid_at >= ?', [weekAgo])?.s) || 0;

  return { totalOrders, paidOrders, pendingOrders, failedOrders, totalMoney, weekMoney };
}

/** Find PROCESSING orders older than the given age (ms) — for background auto-complete */
export function findStuckProcessingOrders(maxAgeMs: number): PaymentOrder[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  return queryAll(
    "SELECT * FROM payment_orders WHERE status = 'PROCESSING' AND created_at < ? AND voucher_code IS NULL ORDER BY created_at ASC",
    [cutoff]
  ).map(mapOrder);
}

/* ── MAC Associations (for auto-connect) ── */

/** Save or update a MAC-to-voucher association */
export function saveMacAssociation(mac: string, code: string, packageName: string): void {
  const normalizedMac = mac.toUpperCase();
  const existing = queryOne('SELECT * FROM active_users WHERE mac = ? AND last_event = ?', [normalizedMac, 'associated']);
  const now = nowString();

  if (existing) {
    run(
      `UPDATE active_users SET code = ?, package_name = ?, last_event = 'associated', updated_at = ? WHERE mac = ? AND last_event = 'associated'`,
      [code.toUpperCase(), packageName, now, normalizedMac]
    );
  } else {
    run(
      `INSERT INTO active_users (user, code, mac, ip, package_name, login_at, last_event, updated_at, bytes_in, bytes_out)
       VALUES (?, ?, ?, ?, ?, ?, 'associated', ?, 0, 0)`,
      [code.toUpperCase(), code.toUpperCase(), normalizedMac, '', packageName, nowIso(), now]
    );
  }
}

/** Find a voucher code associated with a MAC address */
export function findMacAssociation(mac: string): { code: string; package_name: string } | undefined {
  const normalizedMac = mac.toUpperCase();
  // First check for active associations (last_event = 'associated')
  const row = queryOne(
    "SELECT * FROM active_users WHERE mac = ? AND last_event = 'associated' ORDER BY updated_at DESC LIMIT 1",
    [normalizedMac]
  );
  if (row && row.code) {
    return { code: row.code, package_name: row.package_name || '' };
  }
  return undefined;
}

/** Check if a voucher has expired based on its created_at + limit_uptime */
export function isVoucherExpired(voucher: { created_at: string; limit_uptime: string }): boolean {
  const maxDurationMs = parseLimitUptime(voucher.limit_uptime);
  if (maxDurationMs <= 0) return false; // Unknown format — don't assume expired
  const createdAt = new Date(voucher.created_at).getTime();
  const expiryTime = createdAt + maxDurationMs;
  return Date.now() > expiryTime;
}

/** Mark voucher as used/expired in the database */
export function markVoucherExpired(code: string): void {
  run(
    `UPDATE vouchers SET status = 'used', updated_at = ? WHERE code = ? AND status != 'used'`,
    [nowString(), code.toUpperCase()]
  );
  logger.info('DB', `Voucher ${code} marked as used (expired)`);
}

/** Delete a MAC association (e.g. when the voucher has expired) */
export function deleteMacAssociation(mac: string): void {
  const normalizedMac = mac.toUpperCase();
  const existing = queryOne('SELECT * FROM active_users WHERE mac = ? AND last_event = ?', [normalizedMac, 'associated']);
  if (existing) {
    run('DELETE FROM active_users WHERE mac = ? AND last_event = ?', [normalizedMac, 'associated']);
    logger.info('DB', `Deleted expired MAC association for ${normalizedMac}`);
  }
}

/* ── Report active sessions from MikroTik (called by scheduler script) ── */

/**
 * Bulk-report active sessions from MikroTik hotspot active list.
 * Called by the MikroTik scheduler via POST /api/report-active-bulk.
 * Each session is upserted into active_users.
 */
export function reportActiveSessions(sessions: { user: string; mac: string; ip: string }[]): number {
  let count = 0;
  for (const s of sessions) {
    if (s.user && s.user.trim()) {
      upsertActiveUser(s.user.trim().toUpperCase(), s.user.trim().toUpperCase(), s.mac || '', s.ip || '', null);
      count++;
    }
  }
  return count;
}

/* ── Connected Users (real-time active sessions) ── */

/** Get users recently active (deduplicated by MAC, any event within last 5 minutes) */
export function getConnectedUsers(): ActiveUser[] {
  const freshAfter = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = queryAll(
    "SELECT * FROM active_users WHERE updated_at >= ? ORDER BY updated_at DESC",
    [freshAfter]
  );
  // Deduplicate by MAC address (prefer) or username. Keep the most recent entry.
  const seen = new Map<string, any>();
  for (const r of rows) {
    const key = (r.mac || '').trim().toUpperCase() || (r.user || '').trim().toUpperCase();
    if (!key) continue;
    // Keep the first (most recent due to ORDER BY login_at DESC)
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  const unique = Array.from(seen.values());
  return unique.map((r: any) => ({
    id: r.id, user: r.user, code: r.code,
    mac: r.mac || '', ip: r.ip || '',
    package_name: r.package_name || '',
    login_at: r.login_at || '',
    last_event: r.last_event, updated_at: r.updated_at,
    bytes_in: Number(r.bytes_in) || 0,
    bytes_out: Number(r.bytes_out) || 0,
  }));
}

/** Get total count of unique connected users (uses same dedup logic as getConnectedUsers) */
export function getConnectedUsersCount(): number {
  return getConnectedUsers().length;
}

/* ── Clear all data (for reset) ── */

export function clearAllData(): void {
  const tables = ['payment_orders', 'vouchers', 'sms_logs', 'active_users', 'webhook_events'];
  for (const table of tables) {
    run(`DELETE FROM ${table}`);
  }
  logger.info('DB', 'All data cleared (all tables)');
}

/* ── Settings (key-value store for dynamic config) ── */

/** Get a setting value by key */
export function getSetting(key: string): string | undefined {
  const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value;
}

/** Set a setting value (insert or update) */
export function setSetting(key: string, value: string): void {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

/* ── Admin Password ── */

/** Get the admin password from DB (if set), otherwise undefined */
export function getAdminPassword(): string | undefined {
  return getSetting('admin_password');
}

/** Change the admin password (saved to DB) */
export function changeAdminPassword(newPassword: string): void {
  setSetting('admin_password', newPassword);
  logger.info('DB', 'Admin password changed');
}

/* ── Revenue ── */

/** Get daily revenue for the last N days (for charts) */
export function getDailyRevenue(days = 14): { date: string; amount: number; count: number }[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = queryAll(
    `SELECT DATE(paid_at) as day, COALESCE(SUM(amount),0) as amount, COUNT(*) as count
     FROM payment_orders WHERE voucher_code IS NOT NULL AND paid_at >= ?
     GROUP BY DATE(paid_at) ORDER BY day ASC`,
    [cutoff]
  );
  return rows.map((r: any) => ({
    date: r.day, amount: Number(r.amount), count: Number(r.count),
  }));
}

/** Get all customers (distinct phone numbers) */
export function getAllCustomers(): { phone: string; totalOrders: number; totalSpent: number; lastOrder: string }[] {
  return queryAll(
    `SELECT phone, COUNT(*) as totalOrders, COALESCE(SUM(amount),0) as totalSpent, MAX(created_at) as lastOrder
     FROM payment_orders GROUP BY phone ORDER BY lastOrder DESC LIMIT 200`
  ).map((r: any) => ({
    phone: r.phone, totalOrders: Number(r.totalOrders),
    totalSpent: Number(r.totalSpent), lastOrder: r.lastOrder,
  }));
}

/** Get recent system events (webhook_events + voucher creations) */
export function getSystemEvents(limit = 50): { id: number; type: string; message: string; time: string }[] {
  const webhooks = queryAll('SELECT id, order_reference, status, created_at FROM webhook_events ORDER BY id DESC LIMIT ?', [limit]);
  const vouchers = queryAll("SELECT code, 'voucher_created' as event, status, created_at FROM vouchers ORDER BY id DESC LIMIT ?", [limit]);
  const events: any[] = [];
  for (const w of webhooks) {
    events.push({ id: w.id, type: 'webhook', message: `Webhook: ${w.status} — ${w.order_reference || ''}`, time: w.created_at });
  }
  for (const v of vouchers) {
    events.push({ id: events.length + 1, type: 'voucher', message: `Vocha ${v.code} — ${v.status}`, time: v.created_at });
  }
  events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return events.slice(0, limit);
}

/** Get monthly revenue for the last N months (for charts) */
export function getMonthlyRevenue(months = 12): { month: string; amount: number; count: number }[] {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const isoCutoff = cutoff.toISOString();
  const rows = queryAll(
    `SELECT strftime('%Y-%m', paid_at) as month, COALESCE(SUM(amount),0) as amount, COUNT(*) as count
     FROM payment_orders WHERE voucher_code IS NOT NULL AND paid_at >= ?
     GROUP BY strftime('%Y-%m', paid_at) ORDER BY month ASC`,
    [isoCutoff]
  );
  return rows.map((r: any) => ({
    month: r.month, amount: Number(r.amount), count: Number(r.count),
  }));
}

/* ── Cleanup ── */

export function cleanupOldData(retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  // sql.js run() doesn't return changes count, so we query before/after
  const beforeOrders = (queryOne('SELECT COUNT(*) as c FROM payment_orders')?.c) || 0;
  const beforeVouchers = (queryOne('SELECT COUNT(*) as c FROM vouchers')?.c) || 0;
  const beforeSms = (queryOne('SELECT COUNT(*) as c FROM sms_logs')?.c) || 0;

  run('DELETE FROM payment_orders WHERE created_at < ?', [cutoff]);
  run('DELETE FROM vouchers WHERE created_at < ?', [cutoff]);
  run('DELETE FROM sms_logs WHERE created_at < ?', [cutoff]);

  const afterOrders = (queryOne('SELECT COUNT(*) as c FROM payment_orders')?.c) || 0;
  const afterVouchers = (queryOne('SELECT COUNT(*) as c FROM vouchers')?.c) || 0;
  const afterSms = (queryOne('SELECT COUNT(*) as c FROM sms_logs')?.c) || 0;

  const removedOrders = beforeOrders - afterOrders;
  const removedVouchers = beforeVouchers - afterVouchers;
  const removedSms = beforeSms - afterSms;

  if (removedOrders > 0 || removedVouchers > 0 || removedSms > 0) {
    logger.info('Cleanup', `Removed ${removedOrders} orders, ${removedVouchers} vouchers, ${removedSms} SMS logs older than ${retentionDays} days`);
  }
}
