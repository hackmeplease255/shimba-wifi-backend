/**
 * SHIMBA WiFi Backend — Entry Point.
 *
 * 1. Initializes the SQLite database (async via sql.js)
 * 2. Runs migration from data.json (if needed)
 * 3. Starts the HTTP server
 * 4. Schedules periodic data cleanup
 */
import { config } from './config';
import { initDb, cleanupOldData, closeDb, findStuckProcessingOrders } from './db';
import { logger } from './utils';
import app from './app';
import { migrate } from './migrate';
import { issueVoucherForOrder } from './routes/payments';
import fs from 'fs';

/* ── Main ── */
async function main() {
  /* 1. Initialize Database */
  logger.info('App', 'Initializing database...');
  await initDb();

  /* 2. Migrate from data.json if it exists */
  const jsonPath = config.migrateFromJson;
  if (fs.existsSync(jsonPath)) {
    logger.info('App', 'Found data.json — running migration...');
    try {
      await migrate();
      // Rename so we don't re-import
      fs.renameSync(jsonPath, jsonPath + '.migrated');
      logger.info('App', 'Migration complete. data.json renamed to data.json.migrated');
    } catch (err) {
      logger.error('App', 'Migration failed', { error: err });
    }
  }

  /* 3. Start HTTP Server */
  app.listen(config.port, '0.0.0.0', () => {
    logger.info('App', `SHIMBA WiFi backend running on http://localhost:${config.port}`);
    logger.info('App', `Public URL: ${config.publicBaseUrl}`);
  });

  /* 4. Auto-complete stuck orders every 30 seconds */
  // If Mongike webhook doesn't arrive (network issue, timeout, etc.),
  // this background job auto-completes orders after ~75 seconds.
  const AUTO_COMPLETE_AFTER_MS = 75_000;
  const AUTO_COMPLETE_INTERVAL = 30_000;

  setInterval(async () => {
    try {
      const stuck = findStuckProcessingOrders(AUTO_COMPLETE_AFTER_MS);
      for (const order of stuck) {
        logger.info('Payment', `Auto-completing order ${order.order_reference} (${Math.round((Date.now() - new Date(order.created_at).getTime()) / 1000)}s elapsed)`);
        try {
          const result = await issueVoucherForOrder(order.order_reference);
          if (result.created) {
            logger.info('Payment', `Auto-complete: voucher ${result.voucher_code} issued for ${order.order_reference}`);
          } else {
            logger.info('Payment', `Auto-complete: order ${order.order_reference} already has voucher ${result.voucher_code}`);
          }
        } catch (err) {
          logger.error('Payment', 'Auto-complete failed', { order: order.order_reference, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      logger.error('Payment', 'Auto-complete cycle error', { error: err instanceof Error ? err.message : String(err) });
    }
  }, AUTO_COMPLETE_INTERVAL);

  // Run auto-complete once on startup (for any orders that got stuck during restart)
  setTimeout(async () => {
    try {
      const stuck = findStuckProcessingOrders(AUTO_COMPLETE_AFTER_MS);
      if (stuck.length > 0) {
        logger.info('Payment', `Auto-complete startup: found ${stuck.length} stuck orders`);
        for (const order of stuck) {
          try {
            await issueVoucherForOrder(order.order_reference);
          } catch { /* logged inside */ }
        }
      }
    } catch (err) {
      logger.warn('Payment', 'Auto-complete startup error', { error: err instanceof Error ? err.message : String(err) });
    }
  }, 5_000);

  /* 5. Schedule Daily Cleanup */
  setInterval(() => {
    try {
      cleanupOldData(config.dataRetentionDays);
    } catch (err) {
      logger.error('Cleanup', 'Scheduled cleanup failed', { error: err });
    }
  }, 24 * 60 * 60 * 1000);

  // Run cleanup once on startup
  cleanupOldData(config.dataRetentionDays);
}

/* ── Startup ── */
main().catch(err => {
  logger.error('App', 'Fatal startup error', { error: err });
  process.exit(1);
});

/* ── Graceful Shutdown ── */
function shutdown() {
  logger.info('App', 'Shutting down...');
  closeDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


