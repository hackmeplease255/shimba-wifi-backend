/**
 * Migration script: imports existing data from data.json into SQLite.
 *
 * Run: npx tsx src/migrate.ts
 *
 * This is safe to run multiple times — it skips records that already exist.
 * After migration, data.json is renamed to data.json.migrated.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { config } from './config';
import { run, queryAll } from './db';
import { logger } from './utils';

interface JsonDb {
  payment_orders: any[];
  vouchers: any[];
  sms_logs: any[];
  active_users: any[];
  webhook_events: any[];
}

function loadJson(): JsonDb {
  const jsonPath = config.migrateFromJson;
  if (!fs.existsSync(jsonPath)) {
    logger.info('Migrate', `No data.json found at ${jsonPath} — nothing to migrate`);
    return { payment_orders: [], vouchers: [], sms_logs: [], active_users: [], webhook_events: [] };
  }
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const db = JSON.parse(raw);
  return {
    payment_orders: db.payment_orders || [],
    vouchers: db.vouchers || [],
    sms_logs: db.sms_logs || [],
    active_users: db.active_users || [],
    webhook_events: db.webhook_events || [],
  };
}

export async function migrate(): Promise<void> {
  logger.info('Migrate', 'Starting migration from data.json to SQLite...');

  const json = loadJson();

  let imported = 0;
  let skipped = 0;

  // Migrate payment_orders
  const existingRefs = new Set(
    (queryAll('SELECT order_reference FROM payment_orders') as any[]).map(r => r.order_reference)
  );

  for (const o of json.payment_orders) {
    if (existingRefs.has(o.order_reference)) { skipped++; continue; }
    run(
      `INSERT INTO payment_orders (id, order_reference, phone, package_name, amount, status, voucher_code, sms_sent, sms_provider, sms_status, paid_at, error, mongike_ref, status_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        o.id || Date.now(),
        o.order_reference,
        o.phone,
        o.package_name,
        o.amount || 0,
        o.status || 'PROCESSING',
        o.voucher_code || null,
        o.sms_sent ? 1 : 0,
        o.sms_provider || null,
        o.sms_status || null,
        o.paid_at || null,
        o.error || null,
        o.mongike_ref || null,
        o.status_detail || null,
        o.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
        o.updated_at || o.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
      ]
    );
    imported++;
  }

  // Migrate vouchers
  const existingCodes = new Set(
    (queryAll('SELECT code FROM vouchers') as any[]).map(r => r.code)
  );

  for (const v of json.vouchers) {
    if (existingCodes.has(v.code)) { skipped++; continue; }
    run(
      `INSERT INTO vouchers (id, code, phone, package_name, amount, mikrotik_profile, limit_uptime, order_reference, synced, synced_at, sms_sent, sms_provider, sms_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v.id || Date.now(),
        v.code,
        v.phone,
        v.package_name,
        v.amount || 0,
        v.mikrotik_profile || '',
        v.limit_uptime || '',
        v.order_reference,
        v.synced ? 1 : 0,
        v.synced_at || null,
        v.sms_sent ? 1 : 0,
        v.sms_provider || null,
        v.sms_status || null,
        v.status || 'issued',
        v.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
        v.updated_at || v.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
      ]
    );
    imported++;
  }

  // Migrate sms_logs
  for (const s of json.sms_logs) {
    run(
      `INSERT INTO sms_logs (id, phone, code, order_reference, sent, provider, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.id || Date.now(),
        s.phone,
        s.code || '',
        s.order_reference || '',
        s.sent ? 1 : 0,
        s.provider || '',
        typeof s.response === 'object' ? JSON.stringify(s.response) : (s.response || ''),
        s.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
      ]
    );
    imported++;
  }

  // Migrate active_users
  for (const u of json.active_users) {
    run(
      `INSERT INTO active_users (user, code, mac, ip, package_name, login_at, last_event, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        u.user || '',
        u.code || '',
        u.mac || '',
        u.ip || '',
        u.package_name || null,
        u.login_at || null,
        u.last_event || 'login',
        u.updated_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
      ]
    );
    imported++;
  }

  // Migrate webhook_events
  for (const e of json.webhook_events) {
    run(
      `INSERT INTO webhook_events (id, order_reference, raw_body, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        e.id || Date.now(),
        e.order_reference || '',
        typeof e.raw_body === 'object' ? JSON.stringify(e.raw_body) : (e.raw_body || ''),
        e.status || '',
        e.created_at || new Date().toISOString().replace('T', ' ').slice(0, 19),
      ]
    );
    imported++;
  }

  logger.info('Migrate', `Migration complete: ${imported} imported, ${skipped} skipped`);
}
