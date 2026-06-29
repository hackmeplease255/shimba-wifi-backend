"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.initDb = initDb;
exports.saveDb = saveDb;
exports.closeDb = closeDb;
exports.queryAll = queryAll;
exports.run = run;
exports.findOrderByReference = findOrderByReference;
exports.findOrdersByPhone = findOrdersByPhone;
exports.createOrder = createOrder;
exports.updateOrderStatus = updateOrderStatus;
exports.updateOrderVoucher = updateOrderVoucher;
exports.updateOrderSmsStatus = updateOrderSmsStatus;
exports.getAllOrders = getAllOrders;
exports.findVoucherByCode = findVoucherByCode;
exports.createVoucher = createVoucher;
exports.markVoucherSynced = markVoucherSynced;
exports.updateVoucherSmsStatus = updateVoucherSmsStatus;
exports.getRecentVouchers = getRecentVouchers;
exports.logSms = logSms;
exports.upsertActiveUser = upsertActiveUser;
exports.findActiveUser = findActiveUser;
exports.logWebhookEvent = logWebhookEvent;
exports.getStats = getStats;
exports.findStuckProcessingOrders = findStuckProcessingOrders;
exports.cleanupOldData = cleanupOldData;
exports.isVoucherExpired = isVoucherExpired;
exports.deleteMacAssociation = deleteMacAssociation;
exports.saveMacAssociation = saveMacAssociation;
exports.findMacAssociation = findMacAssociation;
exports.markVoucherExpired = markVoucherExpired;
exports.reportActiveSessions = reportActiveSessions;
exports.getConnectedUsers = getConnectedUsers;
exports.getConnectedUsersCount = getConnectedUsersCount;
exports.clearAllData = clearAllData;
exports.getDailyRevenue = getDailyRevenue;
exports.getMonthlyRevenue = getMonthlyRevenue;
exports.getAllCustomers = getAllCustomers;
exports.getSystemEvents = getSystemEvents;
exports.getSetting = getSetting;
exports.setSetting = setSetting;
exports.getAdminPassword = getAdminPassword;
exports.changeAdminPassword = changeAdminPassword;
/**
 * SQLite database layer for SHIMBA WiFi.
 * Uses sql.js — a pure-JavaScript SQLite implementation that requires NO native compilation.
 * Perfect for Bot Hosting / Pterodactyl environments where node-gyp may fail.
 *
 * IMPORTANT: sql.js does NOT auto-persist. We manually save the DB to disk
 * after every write operation, with debouncing to batch rapid writes.
 */
const sql_js_1 = __importDefault(require("sql.js"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
const utils_1 = require("./utils");
/* ── Database Singleton ── */
let SQL = null;
let _db = null;
let _saveTimer = null;
/** Get or initialize the database */
function getDb() {
    if (_db)
        return _db;
    throw new Error('Database not initialized. Call initDb() first.');
}
/** Initialize the database (async — must be called before anything else) */
async function initDb() {
    SQL = await (0, sql_js_1.default)();
    const dbDir = path_1.default.dirname(config_1.config.dbPath);
    if (!fs_1.default.existsSync(dbDir)) {
        fs_1.default.mkdirSync(dbDir, { recursive: true });
    }
    if (fs_1.default.existsSync(config_1.config.dbPath)) {
        const buffer = fs_1.default.readFileSync(config_1.config.dbPath);
        _db = new SQL.Database(buffer);
        utils_1.logger.info('DB', `Loaded existing database (${buffer.length} bytes)`);
    }
    else {
        _db = new SQL.Database();
        utils_1.logger.info('DB', 'Created new database');
    }
    initTables(); // Tables created + debounced save scheduled
}
/** Force-save the database to disk immediately */
function saveDb() {
    if (!_db)
        return;
    try {
        const data = _db.export();
        const buffer = Buffer.from(data);
        fs_1.default.writeFileSync(config_1.config.dbPath, buffer);
    }
    catch (err) {
        utils_1.logger.error('DB', 'Failed to save database', { error: err });
    }
}
/** Debounced save — batches rapid writes */
function scheduleSave() {
    if (_saveTimer)
        clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        saveDb();
        _saveTimer = null;
    }, 200); // 200ms debounce
}
/** Close the database */
function closeDb() {
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
function queryAll(sql, params = []) {
    const db = getDb();
    const stmt = db.prepare(sql);
    if (params.length > 0)
        stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}
/** Helper: run a query and return the first row, or undefined */
function queryOne(sql, params = []) {
    const rows = queryAll(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
}
/** Helper: run an INSERT/UPDATE/DELETE */
function run(sql, params = []) {
    const db = getDb();
    db.run(sql, params);
    scheduleSave();
}
/** Helper: convert sql.js row (which may use 0/1 for booleans) to our TS types */
function toBool(val) {
    return val === 1 || val === true || val === '1';
}
/* ── Table Initialization ── */
function initTables() {
    const db = getDb();
    // Note: sql.js is an in-memory SQLite implementation — PRAGMA options like WAL
    // are accepted but don't persist across restarts. This is fine for our use case.
    try {
        db.run('PRAGMA journal_mode=MEMORY');
    }
    catch { /* pragma not critical */ }
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
      updated_at    TEXT NOT NULL
    );
  `);
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
        try {
            db.run(idx);
        }
        catch { /* index already exists */ }
    }
    scheduleSave();
    utils_1.logger.info('DB', 'Tables initialized');
}
/* ── Row mapping helpers ── */
function mapOrder(row) {
    return row ? { ...row, sms_sent: toBool(row.sms_sent) } : row;
}
function mapVoucher(row) {
    return row ? { ...row, synced: toBool(row.synced), sms_sent: toBool(row.sms_sent) } : row;
}
function mapSmsLog(row) {
    return row ? { ...row, sent: toBool(row.sent) } : row;
}
/* ── Payment Orders ── */
function findOrderByReference(ref) {
    return mapOrder(queryOne('SELECT * FROM payment_orders WHERE order_reference = ?', [ref]));
}
function findOrdersByPhone(phone, packageName) {
    const normalized = (0, utils_1.normalizePhone)(phone);
    if (packageName) {
        return queryAll('SELECT * FROM payment_orders WHERE phone = ? AND package_name = ? ORDER BY id DESC', [normalized, packageName]).map(mapOrder);
    }
    return queryAll('SELECT * FROM payment_orders WHERE phone = ? ORDER BY id DESC', [normalized]).map(mapOrder);
}
function createOrder(ref, phone, pkgName, amount) {
    const now = (0, utils_1.nowString)();
    run(`INSERT INTO payment_orders (order_reference, phone, package_name, amount, status, sms_sent, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PROCESSING', 0, ?, ?)`, [ref, (0, utils_1.normalizePhone)(phone), pkgName, amount, now, now]);
    return findOrderByReference(ref);
}
function updateOrderStatus(ref, status, detail, errorMsg) {
    run('UPDATE payment_orders SET status = ?, status_detail = ?, error = ?, updated_at = ? WHERE order_reference = ?', [status, detail || null, errorMsg || null, (0, utils_1.nowString)(), ref]);
}
function updateOrderVoucher(ref, voucherCode, paidAt) {
    run(`UPDATE payment_orders SET voucher_code = ?, paid_at = ?, status = 'SUCCESS', status_detail = 'voucher_issued', updated_at = ?
     WHERE order_reference = ?`, [voucherCode, paidAt, (0, utils_1.nowString)(), ref]);
}
function updateOrderSmsStatus(ref, sent, provider, smsStatus) {
    run('UPDATE payment_orders SET sms_sent = ?, sms_provider = ?, sms_status = ?, updated_at = ? WHERE order_reference = ?', [sent ? 1 : 0, provider, smsStatus, (0, utils_1.nowString)(), ref]);
}
function getAllOrders(limit = 300) {
    return queryAll('SELECT * FROM payment_orders ORDER BY id DESC LIMIT ?', [limit]).map(mapOrder);
}
/* ── Vouchers ── */
function findVoucherByCode(code) {
    return mapVoucher(queryOne('SELECT * FROM vouchers WHERE code = ?', [code.toUpperCase()]));
}
function createVoucher(code, phone, pkgName, amount, mikrotikProfile, limitUptime, orderRef) {
    const now = (0, utils_1.nowString)();
    run(`INSERT INTO vouchers (code, phone, package_name, amount, mikrotik_profile, limit_uptime, order_reference, synced, sms_sent, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'issued', ?, ?)`, [code.toUpperCase(), (0, utils_1.normalizePhone)(phone), pkgName, amount, mikrotikProfile, limitUptime, orderRef, now, now]);
    return findVoucherByCode(code);
}
function markVoucherSynced(code) {
    run('UPDATE vouchers SET synced = 1, synced_at = ?, updated_at = ? WHERE code = ?', [(0, utils_1.nowString)(), (0, utils_1.nowString)(), code.toUpperCase()]);
}
function updateVoucherSmsStatus(code, sent, provider, smsStatus) {
    run('UPDATE vouchers SET sms_sent = ?, sms_provider = ?, sms_status = ?, updated_at = ? WHERE code = ?', [sent ? 1 : 0, provider, smsStatus, (0, utils_1.nowString)(), code.toUpperCase()]);
}
function getRecentVouchers(days = 30) {
    const rows = queryAll('SELECT * FROM vouchers ORDER BY id DESC', []);
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return rows
        .map(mapVoucher)
        .filter(v => new Date(v.created_at).getTime() >= cutoff || new Date(v.updated_at).getTime() >= cutoff);
}
/* ── SMS Logs ── */
function logSms(phone, code, orderRef, sent, provider, response) {
    run('INSERT INTO sms_logs (phone, code, order_reference, sent, provider, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [(0, utils_1.normalizePhone)(phone), code, orderRef, sent ? 1 : 0, provider, response, (0, utils_1.nowString)()]);
}
/* ── Active Users ── */
function upsertActiveUser(userName, code, mac, ip, packageName) {
    const existing = queryOne('SELECT * FROM active_users WHERE user = ?', [userName]);
    const now = (0, utils_1.nowString)();
    const isoNow = (0, utils_1.nowIso)();
    if (existing) {
        run(`UPDATE active_users SET code = ?, mac = ?, ip = ?, package_name = ?, login_at = ?, last_event = 'login', updated_at = ?
       WHERE user = ?`, [code, mac, ip, packageName, isoNow, now, userName]);
    }
    else {
        run(`INSERT INTO active_users (user, code, mac, ip, package_name, login_at, last_event, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'login', ?)`, [userName, code, mac, ip, packageName, isoNow, now]);
    }
}
function findActiveUser(code, mac, ip) {
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
function logWebhookEvent(orderRef, rawBody, status) {
    run('INSERT INTO webhook_events (order_reference, raw_body, status, created_at) VALUES (?, ?, ?, ?)', [orderRef, rawBody, status, (0, utils_1.nowString)()]);
}
/* ── Stats ── */
function getStats() {
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
function findStuckProcessingOrders(maxAgeMs) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return queryAll("SELECT * FROM payment_orders WHERE status = 'PROCESSING' AND created_at < ? AND voucher_code IS NULL ORDER BY created_at ASC", [cutoff]).map(mapOrder);
}
/* ── MAC Associations (for auto-connect) ── */

/** Save or update a MAC-to-voucher association */
function saveMacAssociation(mac, code, packageName) {
    const normalizedMac = mac.toUpperCase();
    const existing = queryOne('SELECT * FROM active_users WHERE mac = ? AND last_event = ?', [normalizedMac, 'associated']);
    const now = (0, utils_1.nowString)();
    if (existing) {
        run(`UPDATE active_users SET code = ?, package_name = ?, last_event = 'associated', updated_at = ? WHERE mac = ? AND last_event = 'associated'`, [code.toUpperCase(), packageName, now, normalizedMac]);
    }
    else {
        run(`INSERT INTO active_users (user, code, mac, ip, package_name, login_at, last_event, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'associated', ?)`, [code.toUpperCase(), code.toUpperCase(), normalizedMac, '', packageName, (0, utils_1.nowIso)(), now]);
    }
}

/** Find a voucher code associated with a MAC address */
function findMacAssociation(mac) {
    const normalizedMac = mac.toUpperCase();
    // First check for active associations (last_event = 'associated')
    const row = queryOne("SELECT * FROM active_users WHERE mac = ? AND last_event = 'associated' ORDER BY updated_at DESC LIMIT 1", [normalizedMac]);
    if (row && row.code) {
        return { code: row.code, package_name: row.package_name || '' };
    }
    return undefined;
}

/** Check if a voucher has expired based on its created_at + limit_uptime */
function isVoucherExpired(voucher) {
    const maxDurationMs = (0, utils_1.parseLimitUptime)(voucher.limit_uptime);
    if (maxDurationMs <= 0)
        return false; // Unknown format — don't assume expired
    const createdAt = new Date(voucher.created_at).getTime();
    const expiryTime = createdAt + maxDurationMs;
    return Date.now() > expiryTime;
}

/** Mark voucher as used/expired in the database */
function markVoucherExpired(code) {
    run(`UPDATE vouchers SET status = 'used', updated_at = ? WHERE code = ? AND status != 'used'`, [(0, utils_1.nowString)(), code.toUpperCase()]);
    utils_1.logger.info('DB', `Voucher ${code} marked as used (expired)`);
}

/** Delete a MAC association (e.g. when the voucher has expired) */
function deleteMacAssociation(mac) {
    const normalizedMac = mac.toUpperCase();
    const existing = queryOne('SELECT * FROM active_users WHERE mac = ? AND last_event = ?', [normalizedMac, 'associated']);
    if (existing) {
        run('DELETE FROM active_users WHERE mac = ? AND last_event = ?', [normalizedMac, 'associated']);
        utils_1.logger.info('DB', `Deleted expired MAC association for ${normalizedMac}`);
    }
}

/* ── Report active sessions from MikroTik (called by scheduler script) ── */

/**
 * Bulk-report active sessions from MikroTik hotspot active list.
 * Called by the MikroTik scheduler via POST /api/report-active-bulk.
 * Each session is upserted into active_users.
 */
function reportActiveSessions(sessions) {
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
function getConnectedUsers() {
    const freshAfter = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const rows = queryAll("SELECT * FROM active_users WHERE updated_at >= ? ORDER BY updated_at DESC", [freshAfter]);
    // Deduplicate by MAC address (prefer) or username. Keep the most recent entry.
    const seen = new Map();
    for (const r of rows) {
        const key = (r.mac || '').trim().toUpperCase() || (r.user || '').trim().toUpperCase();
        if (!key)
            continue;
        // Keep the first (most recent due to ORDER BY login_at DESC)
        if (!seen.has(key)) {
            seen.set(key, r);
        }
    }
    const unique = Array.from(seen.values());
    return unique.map((r) => ({
        id: r.id, user: r.user, code: r.code,
        mac: r.mac || '', ip: r.ip || '',
        package_name: r.package_name || '',
        login_at: r.login_at || '',
        last_event: r.last_event, updated_at: r.updated_at,
    }));
}

/** Get total count of unique connected users (uses same dedup logic as getConnectedUsers) */
function getConnectedUsersCount() {
    return getConnectedUsers().length;
}

/* ── Clear all data (for reset) ── */

function clearAllData() {
    const tables = ['payment_orders', 'vouchers', 'sms_logs', 'active_users', 'webhook_events'];
    for (const table of tables) {
        run(`DELETE FROM ${table}`);
    }
    utils_1.logger.info('DB', 'All data cleared (all tables)');
}

/* ── Settings (key-value store for dynamic config) ── */

/** Get a setting value by key */
function getSetting(key) {
    const row = queryOne('SELECT value FROM settings WHERE key = ?', [key]);
    return row?.value;
}

/** Set a setting value (insert or update) */
function setSetting(key, value) {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

/* ── Admin Password ── */

/** Get the admin password from DB (if set), otherwise undefined */
function getAdminPassword() {
    return getSetting('admin_password');
}

/** Change the admin password (saved to DB) */
function changeAdminPassword(newPassword) {
    setSetting('admin_password', newPassword);
    utils_1.logger.info('DB', 'Admin password changed');
}

/* ── Revenue ── */

/** Get daily revenue for the last N days (for charts) */
function getDailyRevenue(days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = queryAll(`SELECT DATE(paid_at) as day, COALESCE(SUM(amount),0) as amount, COUNT(*) as count FROM payment_orders WHERE voucher_code IS NOT NULL AND paid_at >= ? GROUP BY DATE(paid_at) ORDER BY day ASC`, [cutoff]);
    return rows.map((r) => ({
        date: r.day, amount: Number(r.amount), count: Number(r.count),
    }));
}

/** Get all customers (distinct phone numbers) */
function getAllCustomers() {
    return queryAll(`SELECT phone, COUNT(*) as totalOrders, COALESCE(SUM(amount),0) as totalSpent, MAX(created_at) as lastOrder FROM payment_orders GROUP BY phone ORDER BY lastOrder DESC LIMIT 200`).map((r) => ({
        phone: r.phone, totalOrders: Number(r.totalOrders),
        totalSpent: Number(r.totalSpent), lastOrder: r.lastOrder,
    }));
}

/** Get recent system events (webhook_events + voucher creations) */
function getSystemEvents(limit) {
    const webhooks = queryAll('SELECT id, order_reference, status, created_at FROM webhook_events ORDER BY id DESC LIMIT ?', [limit]);
    const vouchers = queryAll("SELECT code, 'voucher_created' as event, status, created_at FROM vouchers ORDER BY id DESC LIMIT ?", [limit]);
    const events = [];
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
function getMonthlyRevenue(months = 12) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const isoCutoff = cutoff.toISOString();
    const rows = queryAll(`SELECT strftime('%Y-%m', paid_at) as month, COALESCE(SUM(amount),0) as amount, COUNT(*) as count FROM payment_orders WHERE voucher_code IS NOT NULL AND paid_at >= ? GROUP BY strftime('%Y-%m', paid_at) ORDER BY month ASC`, [isoCutoff]);
    return rows.map((r) => ({
        month: r.month, amount: Number(r.amount), count: Number(r.count),
    }));
}

function cleanupOldData(retentionDays) {
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
        utils_1.logger.info('Cleanup', `Removed ${removedOrders} orders, ${removedVouchers} vouchers, ${removedSms} SMS logs older than ${retentionDays} days`);
    }
}
//# sourceMappingURL=db.js.map