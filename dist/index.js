"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * SHIMBA WiFi Backend — Entry Point.
 *
 * 1. Initializes the SQLite database (async via sql.js)
 * 2. Runs migration from data.json (if needed)
 * 3. Starts the HTTP server
 * 4. Schedules periodic data cleanup
 */
const config_1 = require("./config");
const db_1 = require("./db");
const utils_1 = require("./utils");
const app_1 = __importDefault(require("./app"));
const migrate_1 = require("./migrate");
const payments_1 = require("./routes/payments");
const fs_1 = __importDefault(require("fs"));
/* ── Main ── */
async function main() {
    /* 1. Initialize Database */
    utils_1.logger.info('App', 'Initializing database...');
    await (0, db_1.initDb)();
    /* 2. Migrate from data.json if it exists */
    const jsonPath = config_1.config.migrateFromJson;
    if (fs_1.default.existsSync(jsonPath)) {
        utils_1.logger.info('App', 'Found data.json — running migration...');
        try {
            await (0, migrate_1.migrate)();
            // Rename so we don't re-import
            fs_1.default.renameSync(jsonPath, jsonPath + '.migrated');
            utils_1.logger.info('App', 'Migration complete. data.json renamed to data.json.migrated');
        }
        catch (err) {
            utils_1.logger.error('App', 'Migration failed', { error: err });
        }
    }
    /* 3. Start HTTP Server */
    app_1.default.listen(config_1.config.port, '0.0.0.0', () => {
        utils_1.logger.info('App', `SHIMBA WiFi backend running on http://localhost:${config_1.config.port}`);
        utils_1.logger.info('App', `Public URL: ${config_1.config.publicBaseUrl}`);
    });
    /* 4. Auto-complete stuck orders every 30 seconds */
    // If Mongike webhook doesn't arrive (network issue, timeout, etc.),
    // this background job auto-completes orders after ~75 seconds.
    const AUTO_COMPLETE_AFTER_MS = 75_000;
    const AUTO_COMPLETE_INTERVAL = 30_000;
    setInterval(async () => {
        try {
            const stuck = (0, db_1.findStuckProcessingOrders)(AUTO_COMPLETE_AFTER_MS);
            for (const order of stuck) {
                utils_1.logger.info('Payment', `Auto-completing order ${order.order_reference} (${Math.round((Date.now() - new Date(order.created_at).getTime()) / 1000)}s elapsed)`);
                try {
                    const result = await (0, payments_1.issueVoucherForOrder)(order.order_reference);
                    if (result.created) {
                        utils_1.logger.info('Payment', `Auto-complete: voucher ${result.voucher_code} issued for ${order.order_reference}`);
                    }
                    else {
                        utils_1.logger.info('Payment', `Auto-complete: order ${order.order_reference} already has voucher ${result.voucher_code}`);
                    }
                }
                catch (err) {
                    utils_1.logger.error('Payment', 'Auto-complete failed', { order: order.order_reference, error: err instanceof Error ? err.message : String(err) });
                }
            }
        }
        catch (err) {
            utils_1.logger.error('Payment', 'Auto-complete cycle error', { error: err instanceof Error ? err.message : String(err) });
        }
    }, AUTO_COMPLETE_INTERVAL);
    // Run auto-complete once on startup (for any orders that got stuck during restart)
    setTimeout(async () => {
        try {
            const stuck = (0, db_1.findStuckProcessingOrders)(AUTO_COMPLETE_AFTER_MS);
            if (stuck.length > 0) {
                utils_1.logger.info('Payment', `Auto-complete startup: found ${stuck.length} stuck orders`);
                for (const order of stuck) {
                    try {
                        await (0, payments_1.issueVoucherForOrder)(order.order_reference);
                    }
                    catch { /* logged inside */ }
                }
            }
        }
        catch (err) {
            utils_1.logger.warn('Payment', 'Auto-complete startup error', { error: err instanceof Error ? err.message : String(err) });
        }
    }, 5_000);
    /* 5. Schedule Daily Cleanup */
    setInterval(() => {
        try {
            (0, db_1.cleanupOldData)(config_1.config.dataRetentionDays);
        }
        catch (err) {
            utils_1.logger.error('Cleanup', 'Scheduled cleanup failed', { error: err });
        }
    }, 24 * 60 * 60 * 1000);
    // Run cleanup once on startup
    (0, db_1.cleanupOldData)(config_1.config.dataRetentionDays);
}
/* ── Startup ── */
main().catch(err => {
    utils_1.logger.error('App', 'Fatal startup error', { error: err });
    process.exit(1);
});
/* ── Graceful Shutdown ── */
function shutdown() {
    utils_1.logger.info('App', 'Shutting down...');
    (0, db_1.closeDb)();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
//# sourceMappingURL=index.js.map