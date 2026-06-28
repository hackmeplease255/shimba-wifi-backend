"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const db_1 = require("../db");
const utils_1 = require("../utils");
const rateLimiter_1 = require("../middleware/rateLimiter");
const payments_1 = require("./payments");
const router = (0, express_1.Router)();
/**
 * Mongike payment webhook — GET handler (helpful message only).
 * Mongike sends POST requests; this prevents confusion when testing in browser.
 */
router.get('/api/mongike-webhook', (_req, res) => {
    res.json({
        success: false,
        message: 'Sehemu hii inakubali POST kutoka Mongike pekee. Fungua SHIMBA WiFi portal kwenye browser kupata vocha.',
        note: 'Mongike sends POST callbacks here when payment completes. Visiting in browser (GET) will always show this message.',
    });
});
/**
 * Mongike payment webhook (POST).
 * Called by Mongike when a payment completes, fails, or expires.
 * Validates the x-api-key header against MONGIKE_API_KEY.
 */
router.post('/api/mongike-webhook', rateLimiter_1.webhookLimiter, async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== config_1.config.mongike.apiKey) {
        utils_1.logger.warn('Webhook', 'Invalid API key', { ip: req.ip });
        return res.status(401).json({ success: false, message: 'Invalid API key' });
    }
    const p = req.body || {};
    const orderReference = p.order_id;
    // Mongike sends 'status' = 'COMPLETED' (not 'payment_status')
    // Try multiple field names for compatibility
    const rawStatus = String(p.status || p.payment_status || p.transaction_status || p.state || p.event || '').toUpperCase();
    const paymentStatus = rawStatus === 'PAYMENT_COMPLETED' ? 'COMPLETED' : rawStatus;
    const rawBody = JSON.stringify(p);
    utils_1.logger.info('Webhook', 'Received', { orderReference, paymentStatus, rawBody: rawBody.slice(0, 500) });
    if (!orderReference) {
        return res.status(400).json({ success: false, message: 'Missing order_id' });
    }
    (0, db_1.logWebhookEvent)(orderReference, rawBody, paymentStatus || 'UNKNOWN');
    const order = (0, db_1.findOrderByReference)(orderReference);
    if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
    }
    // Prevent duplicate processing
    if (order.voucher_code) {
        utils_1.logger.info('Webhook', 'Order already has voucher — skipping duplicate', { orderReference, voucher: order.voucher_code });
        return res.json({ success: true, voucher_code: order.voucher_code });
    }
    const status = (0, utils_1.normalizeStatus)(paymentStatus);
    if (status === 'SUCCESS') {
        try {
            const result = await (0, payments_1.issueVoucherForOrder)(orderReference);
            return res.json({ success: true, voucher_code: result.voucher_code });
        }
        catch (err) {
            utils_1.logger.error('Webhook', 'Failed to issue voucher', { orderReference, error: err });
            return res.status(500).json({ success: false, message: 'Failed to issue voucher' });
        }
    }
    if (status === 'FAILED') {
        (0, db_1.updateOrderStatus)(orderReference, 'FAILED', 'payment_failed', p.reason || paymentStatus);
        return res.json({ success: true, status: 'FAILED' });
    }
    // Still processing
    (0, db_1.updateOrderStatus)(orderReference, status);
    res.json({ success: true, status });
});
exports.default = router;
//# sourceMappingURL=webhook.js.map