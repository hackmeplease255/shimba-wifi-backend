"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const rateLimiter_1 = require("../middleware/rateLimiter");
const db_1 = require("../db");
const validation_1 = require("../middleware/validation");
const payments_1 = require("./payments");
const config_1 = require("../config");
const utils_1 = require("../utils");
const mikrotik_1 = require("../mikrotik");
const { removeUser } = mikrotik_1;
const router = (0, express_1.Router)();
/* ── Admin login (get JWT token) ── */
router.post('/api/admin/login', rateLimiter_1.adminLimiter, auth_1.loginHandler);
/* ── Dashboard stats ── */
router.get('/api/admin/stats', auth_1.adminAuth, (_req, res) => {
    const stats = (0, db_1.getStats)();
    res.json({ success: true, ...stats });
});
/* ── List recent orders ── */
router.get('/api/admin/orders', auth_1.adminAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const orders = (0, db_1.getAllOrders)(limit);
    res.json({ success: true, orders });
});
/* ── Manually complete a stuck payment ── */
/* ── View recent webhook events (to debug Mongike format) ── */
router.get('/api/admin/webhook-events', auth_1.adminAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const events = (0, db_1.queryAll)('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?', [limit]);
    res.json({ success: true, events });
});
router.post('/api/admin/complete-order', auth_1.adminAuth, validation_1.validateOrderRef, async (req, res) => {
    const { order_reference } = req.body || {};
    if (!order_reference) {
        return res.status(400).json({ success: false, message: 'Tafadhali toa order_reference' });
    }
    try {
        const result = await (0, payments_1.issueVoucherForOrder)(order_reference);
        res.json({
            success: true,
            message: 'Vocha imetengenezwa!',
            voucher_code: result.voucher_code,
        });
    }
    catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});
/* ── List vouchers ── */
router.get('/api/admin/vouchers', auth_1.adminAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const vouchers = (0, db_1.queryAll)('SELECT * FROM vouchers ORDER BY id DESC LIMIT ?', [limit]);
    res.json({ success: true, vouchers });
});

/* ── Connected users (real-time, enriched with voucher data) ── */
router.get('/api/admin/connected-users', auth_1.adminAuth, (_req, res) => {
    const users = (0, db_1.getConnectedUsers)();
    const count = (0, db_1.getConnectedUsersCount)();
    // Enrich each user with voucher data (phone, amount, status, remaining time)
    const enriched = users.map(u => {
        const voucher = u.code ? (0, db_1.findVoucherByCode)(u.code) : null;
        let remainingMs = 0;
        let remainingLabel = '';
        if (voucher) {
            const maxMs = (0, utils_1.parseLimitUptime)(voucher.limit_uptime);
            if (maxMs > 0 && u.login_at) {
                const elapsed = Date.now() - new Date(u.login_at).getTime();
                remainingMs = Math.max(0, maxMs - elapsed);
                const mins = Math.floor(remainingMs / 60000);
                if (mins >= 1440)
                    remainingLabel = `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
                else if (mins >= 60)
                    remainingLabel = `${Math.floor(mins / 60)}h ${mins % 60}m`;
                else
                    remainingLabel = `${mins}m`;
            }
        }
        return {
            user: u.user,
            code: u.code,
            mac: u.mac,
            ip: u.ip,
            package_name: u.package_name,
            login_at: u.login_at,
            phone: (voucher?.phone && voucher.phone !== 'ADMIN_CASH') ? voucher.phone : '',
            amount: voucher?.amount || 0,
            voucher_status: voucher?.status || '',
            remaining: remainingLabel,
            remaining_ms: remainingMs,
            login_since: u.login_at ? Math.floor((Date.now() - new Date(u.login_at).getTime()) / 60000) : 0,
            bytes_in: u.bytes_in || 0,
            bytes_out: u.bytes_out || 0,
        };
    });
    res.json({ success: true, users: enriched, totalUnique: count });
});

/* ── Clear all data (reset for new client) ── */
router.post('/api/admin/clear-data', auth_1.adminAuth, (req, res) => {
    const { confirm } = req.body || {};
    if (confirm !== 'RESET_ALL_DATA') {
        return res.status(400).json({
            success: false,
            message: 'Tafadhali tuma confirm="RESET_ALL_DATA" kuthibitisha.',
        });
    }
    (0, db_1.clearAllData)();
    utils_1.logger.info('Admin', 'All data cleared by admin');
    res.json({ success: true, message: 'Data zote zimefutwa kikamilifu!' });
});

/* ── Daily revenue (for charts) ── */
router.get('/api/admin/daily-revenue', auth_1.adminAuth, (req, res) => {
    const days = Math.min(Number(req.query.days) || 14, 90);
    const revenue = (0, db_1.getDailyRevenue)(days);
    res.json({ success: true, revenue });
});

/* ── Monthly revenue (for charts) ── */
router.get('/api/admin/monthly-revenue', auth_1.adminAuth, (req, res) => {
    const months = Math.min(Number(req.query.months) || 12, 36);
    const revenue = (0, db_1.getMonthlyRevenue)(months);
    res.json({ success: true, revenue });
});

/* ── Customers list ── */
router.get('/api/admin/customers', auth_1.adminAuth, (_req, res) => {
    const customers = (0, db_1.getAllCustomers)();
    res.json({ success: true, customers });
});

/* ── System events / logs ── */
router.get('/api/admin/system-events', auth_1.adminAuth, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const events = (0, db_1.getSystemEvents)(limit);
    res.json({ success: true, events });
});

/* ── System health (admin version) ── */
router.get('/api/admin/system-info', auth_1.adminAuth, (_req, res) => {
    res.json({
        success: true,
        version: '2.0.0',
        nodeVersion: process.version,
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        platform: process.platform,
        timestamp: new Date().toISOString(),
    });
});

/* ── Change admin password ── */
router.post('/api/admin/change-password', auth_1.adminAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Tafadhali toa currentPassword na newPassword' });
    }
    if (newPassword.length < 4) {
        return res.status(400).json({ success: false, message: 'Password mpya inahitaji angalau herufi 4' });
    }
    // Verify current password against config (env) or DB
    const dbPassword = (0, db_1.getAdminPassword)();
    const currentValid = currentPassword === config_1.config.admin.password ||
        (dbPassword && currentPassword === dbPassword);
    if (!currentValid) {
        return res.status(401).json({ success: false, message: 'Password ya sasa si sahihi' });
    }
    (0, db_1.changeAdminPassword)(newPassword);
    utils_1.logger.info('Admin', 'Password changed by admin');
    res.json({ success: true, message: 'Password imebadilishwa kikamilifu!' });
});

/* ── Disconnect a user (force logout from hotspot) ── */
router.post('/api/admin/disconnect-user', auth_1.adminAuth, async (req, res) => {
    const { code, mac } = req.body || {};
    const userCode = String(code || '').trim().toUpperCase();
    if (!userCode) {
        return res.status(400).json({ success: false, message: 'Tafadhali toa voucher code ya mtumiaji' });
    }
    try {
        // 1. Remove from active_users immediately
        (0, db_1.run)('DELETE FROM active_users WHERE user = ? OR code = ?', [userCode, userCode]);
        // Remove MAC association if provided
        if (mac) {
            (0, db_1.run)("DELETE FROM active_users WHERE mac = ? AND last_event = 'associated'", [mac.toUpperCase()]);
        }
        // 2. Try MikroTik API to remove hotspot user + kill session
        const apiRemoved = await (0, mikrotik_1.removeUser)(userCode);
        if (apiRemoved) {
            utils_1.logger.info('Admin', `User ${userCode} disconnected via API`);
            return res.json({
                success: true,
                message: 'Mtumiaji ametolewa kwenye mtandao kikamilifu!',
                method: 'api',
            });
        }
        // 3. API unreachable (private IP) — queue for RSC-based removal
        (0, db_1.addPendingDisconnect)(userCode);
        utils_1.logger.info('Admin', `User ${userCode} queued for RSC-based disconnect`);
        res.json({
            success: true,
            message: 'Mtumiaji ametolewa kwenye database. Atatolewa kwenye MikroTik baada ya sync (sekunde 10-30).',
            method: 'rsc_queue',
        });
    }
    catch (e) {
        utils_1.logger.error('Admin', 'Failed to disconnect user', { code: userCode, error: e.message });
        res.status(500).json({ success: false, message: 'Imeshindikana kumtoa mtumiaji: ' + e.message });
    }
});

/* ── Admin: Create voucher manually (without payment) ── */
router.post('/api/admin/create-voucher', auth_1.adminAuth, async (req, res) => {
    const { phone, package_name } = req.body || {};
    if (!package_name || !(0, config_1.isValidPackage)(package_name)) {
        return res.status(400).json({ success: false, message: 'Tafadhali toa package sahihi (6hours, 24hours, 48hours, 7days)' });
    }
    // Phone is optional — admin may give voucher directly without recording phone
    const normalizedPhone = phone ? (0, utils_1.normalizePhone)(phone) : 'ADMIN_CASH';
    if (phone && !(0, utils_1.isValidPhone)(normalizedPhone)) {
        return res.status(400).json({ success: false, message: 'Namba ya simu si sahihi. Tumia format: 07xxxxxxxx au 06xxxxxxxx' });
    }
    try {
        const pkg = (0, config_1.getPackage)(package_name);
        const orderReference = (0, utils_1.makeOrderReference)();
        // Create payment order (marked as SUCCESS, admin-created)
        (0, db_1.createOrder)(orderReference, normalizedPhone, package_name, pkg.amount);
        // Create voucher directly
        let code = (0, utils_1.generateVoucherCode)();
        let tries = 0;
        while ((0, db_1.findVoucherByCode)(code) && tries < 50) {
            code = (0, utils_1.generateVoucherCode)();
            tries++;
        }
        const paidAt = (0, utils_1.nowString)();
        (0, db_1.updateOrderVoucher)(orderReference, code, paidAt);
        (0, db_1.createVoucher)(code, normalizedPhone, package_name, pkg.amount, pkg.mikrotik_profile, pkg.limit_uptime, orderReference);
        // Try to push to MikroTik
        try {
            const synced = await (0, mikrotik_1.pushVoucher)({
                code, package_name,
                mikrotik_profile: pkg.mikrotik_profile, limit_uptime: pkg.limit_uptime, order_reference: orderReference,
            });
            if (synced) {
                (0, db_1.markVoucherSynced)(code);
                utils_1.logger.info('Admin', `Voucher ${code} created and synced to MikroTik by admin`);
            }
            else {
                utils_1.logger.info('Admin', `Voucher ${code} created by admin (will sync via .rsc)`);
            }
        }
        catch (err) {
            utils_1.logger.warn('Admin', `Voucher ${code} created by admin but push failed (will sync via .rsc)`);
        }
        res.json({
            success: true,
            message: 'Vocha imetengenezwa kikamilifu!',
            voucher_code: code,
            order_reference: orderReference,
            phone: normalizedPhone,
            package: package_name,
            amount: pkg.amount,
        });
    }
    catch (e) {
        utils_1.logger.error('Admin', 'Failed to create voucher', { error: e.message });
        res.status(500).json({ success: false, message: 'Imeshindikana kutengeneza vocha: ' + e.message });
    }
});
exports.default = router;
//# sourceMappingURL=admin.js.map