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