"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueVoucherForOrder = issueVoucherForOrder;
const express_1 = require("express");
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const db_1 = require("../db");
const utils_1 = require("../utils");
const mikrotik_1 = require("../mikrotik");
const sms_1 = require("../sms");
const validation_1 = require("../middleware/validation");
const rateLimiter_1 = require("../middleware/rateLimiter");
const health_1 = require("./health");
const router = (0, express_1.Router)();
/* ── Initiate payment ── */
router.post('/pay-mongike', rateLimiter_1.paymentLimiter, validation_1.validatePayRequest, async (req, res) => {
    const { phone, package_name, amount } = req.body;
    const pkg = (0, config_1.getPackage)(package_name);
    if (!pkg) {
        return res.status(400).json({ success: false, message: 'Invalid package' });
    }
    if (!config_1.config.mongike.apiKey) {
        return res.status(500).json({ success: false, message: 'Mongike API key haijawekwa' });
    }
    const orderReference = (0, utils_1.makeOrderReference)();
    (0, db_1.createOrder)(orderReference, phone, package_name, amount);
    try {
        const webhookUrl = (0, health_1.getWebhookUrl)();
        utils_1.logger.info('Payment', `Initiating order ${orderReference}`, { amount, phone, webhookUrl });
        await axios_1.default.post(`${config_1.config.mongike.baseUrl}${config_1.config.mongike.paymentEndpoint}`, {
            order_id: orderReference,
            amount: pkg.amount,
            buyer_phone: phone,
            fee_payer: 'MERCHANT',
            webhook_url: webhookUrl,
        }, {
            headers: {
                'x-api-key': config_1.config.mongike.apiKey,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
        res.json({
            success: true,
            orderReference,
            message: 'Payment request sent. Angalia simu yako na thibitisha PIN.',
            status: 'PROCESSING',
        });
    }
    catch (error) {
        const errorMessage = error.response?.data?.message || error.response?.data || error.message;
        utils_1.logger.error('Payment', 'Mongike request failed', { orderReference, error: errorMessage });
        (0, db_1.updateOrderStatus)(orderReference, 'FAILED', 'payment_failed', typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage));
        res.status(500).json({
            success: false,
            message: 'Payment request failed. Tafadhali jaribu tena.',
            error: errorMessage,
        });
    }
});
/* ── Check payment status (READ-ONLY — never issues vouchers) ── */
router.get('/payment-status/:orderReference', validation_1.validateOrderRef, async (req, res) => {
    const orderReference = String(req.params.orderReference);
    const order = (0, db_1.findOrderByReference)(orderReference);
    if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.voucher_code) {
        return res.json({
            success: true, paid: true, status: 'SUCCESS',
            voucher_code: order.voucher_code,
            order_reference: orderReference,
        });
    }
    if (['FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(String(order.status || '').toUpperCase())) {
        return res.json({
            success: true, paid: false, status: 'FAILED',
            status_detail: 'payment_failed',
        });
    }
    // IMPORTANT: This endpoint is READ-ONLY. It only checks status.
    // Vouchers are issued exclusively by the Mongike webhook (/api/mongike-webhook).
    // NEVER issue a voucher in this GET endpoint — that would give free vouchers on every poll!
    res.json({
        success: true, paid: false,
        status: order.status || 'PROCESSING',
        status_detail: 'payment_pending',
    });
});
/* ── Latest voucher by phone ── */
router.get('/api/latest-voucher', async (req, res) => {
    const phone = (0, utils_1.normalizePhone)(String(req.query.phone ?? ''));
    const packageName = String(req.query.package_name ?? '').trim();
    if (!(0, utils_1.isValidPhone)(phone)) {
        return res.status(400).json({ success: false, message: 'Invalid phone' });
    }
    const orders = (0, db_1.findOrdersByPhone)(phone, packageName || undefined)
        .filter(o => o.voucher_code)
        .sort((a, b) => b.id - a.id);
    const order = orders[0];
    if (!order) {
        return res.status(404).json({ success: false, message: 'No paid voucher found for this phone' });
    }
    const voucher = (0, db_1.findVoucherByCode)(order.voucher_code);
    res.json({
        success: true,
        order: {
            order_reference: order.order_reference,
            package_name: order.package_name,
            status: order.status,
            paid_at: order.paid_at || null,
        },
        voucher: voucher ? {
            code: voucher.code,
            synced: !!voucher.synced,
            synced_at: voucher.synced_at || null,
            package_name: voucher.package_name,
            mikrotik_profile: voucher.mikrotik_profile,
        } : {
            code: order.voucher_code,
            synced: false,
            synced_at: null,
            package_name: order.package_name,
            mikrotik_profile: null,
        },
    });
});
/* ── Get voucher by order reference ── */
router.get('/api/order-voucher/:orderReference', validation_1.validateOrderRef, (req, res) => {
    const orderReference = String(req.params.orderReference || '').trim();
    const order = (0, db_1.findOrderByReference)(orderReference);
    if (!order) {
        return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (!order.voucher_code) {
        return res.status(404).json({ success: false, message: 'Voucher not ready' });
    }
    const voucher = (0, db_1.findVoucherByCode)(order.voucher_code);
    res.json({
        success: true,
        order: {
            order_reference: order.order_reference,
            package_name: order.package_name,
            status: order.status,
            paid_at: order.paid_at || null,
        },
        voucher: voucher ? {
            code: voucher.code,
            synced: !!voucher.synced,
            synced_at: voucher.synced_at || null,
            package_name: voucher.package_name,
            mikrotik_profile: voucher.mikrotik_profile,
            status: voucher.status || 'issued',
            sms_sent: !!voucher.sms_sent,
        } : {
            code: order.voucher_code,
            synced: false,
            synced_at: null,
            package_name: order.package_name,
            mikrotik_profile: null,
            status: 'issued',
            sms_sent: !!order.sms_sent,
        },
    });
});
/* ── Voucher status ── */
router.get('/api/voucher-status/:code', (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const voucher = (0, db_1.findVoucherByCode)(code);
    if (!voucher) {
        return res.status(404).json({ success: false, message: 'Vocha haijapatikana' });
    }
    res.json({
        success: true,
        status: voucher.status === 'issued' ? 'valid' : voucher.status,
        voucher: {
            code: voucher.code,
            synced: !!voucher.synced,
            synced_at: voucher.synced_at || null,
            package_name: voucher.package_name,
            mikrotik_profile: voucher.mikrotik_profile,
            status: voucher.status || 'issued',
            sms_sent: !!voucher.sms_sent,
        },
    });
});
/* ── Resend SMS ── */
router.post('/api/resend-sms', async (req, res) => {
    const { order_reference } = req.body || {};
    if (!order_reference) {
        return res.status(400).json({ success: false, message: 'Toa order_reference' });
    }
    const order = (0, db_1.findOrderByReference)(order_reference);
    if (!order) {
        return res.status(404).json({ success: false, message: 'Order haijapatikana' });
    }
    if (!order.voucher_code) {
        return res.status(400).json({ success: false, message: 'Order hii haina voucher bado' });
    }
    const pkg = (0, config_1.getPackage)(order.package_name);
    try {
        const result = await (0, sms_1.sendVoucherSms)(order.phone, order.voucher_code, pkg?.label || order.package_name);
        (0, db_1.updateOrderSmsStatus)(order_reference, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
        (0, db_1.updateVoucherSmsStatus)(order.voucher_code, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
        (0, db_1.logSms)(order.phone, order.voucher_code, order_reference, result.sent, result.provider, result.response);
        res.json({ success: true, sent: result.sent, provider: result.provider, response: result.response });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
/* ── Test SMS ── */
router.post('/api/test-sms', async (req, res) => {
    const phone = String(req.body?.phone || '0745416143').trim();
    const packageName = String(req.body?.packageName || '24 Hours').trim();
    const code = String(req.body?.code || 'TEST123').trim().toUpperCase();
    utils_1.logger.info('SMS Test', `Testing SMS to ${phone}, code: ${code}, package: ${packageName}`);
    try {
        const result = await (0, sms_1.sendVoucherSms)(phone, code, packageName);
        res.json({
            success: true,
            sent: result.sent,
            provider: result.provider,
            response: result.response,
            phone: (0, utils_1.normalizePhone)(phone),
            debug: {
                SMS_ENABLED: config_1.config.sms.enabled,
                SMS_PROVIDER: config_1.config.sms.provider,
                SMS_API_URL: config_1.config.sms.apiUrl || 'NOT SET',
                SMS_SENDER: config_1.config.sms.sender,
            },
        });
    }
    catch (error) {
        utils_1.logger.error('SMS Test', 'Error', { error: error.message });
        res.status(500).json({
            success: false,
            error: error.message,
            debug: {
                SMS_ENABLED: config_1.config.sms.enabled,
                SMS_PROVIDER: config_1.config.sms.provider,
                SMS_API_URL: config_1.config.sms.apiUrl || 'NOT SET',
                SMS_SENDER: config_1.config.sms.sender,
            },
        });
    }
});
/* ── In-memory lock to prevent double voucher creation from concurrent webhooks ── */
const processingOrders = new Set();
/* ── Shared helper: issue voucher for a paid order ── */
async function issueVoucherForOrder(orderReference) {
    // Lock to prevent concurrent voucher creation for the same order
    if (processingOrders.has(orderReference)) {
        utils_1.logger.info('Payment', `Order ${orderReference} already being processed — waiting...`);
        await new Promise(resolve => {
            const check = setInterval(() => {
                if (!processingOrders.has(orderReference)) {
                    clearInterval(check);
                    resolve(undefined);
                }
            }, 300);
            // Safety timeout: release lock after 30s
            setTimeout(() => { clearInterval(check); resolve(undefined); }, 30_000);
        });
    }
    processingOrders.add(orderReference);
    try {
        const order = (0, db_1.findOrderByReference)(orderReference);
        if (!order)
            throw new Error('Order not found');
        if (order.voucher_code) {
            return { order, voucher_code: order.voucher_code, created: false };
        }
        const pkg = (0, config_1.getPackage)(order.package_name);
        if (!pkg)
            throw new Error('Invalid package for order');
        // Generate unique voucher code
        let code = (0, utils_1.generateVoucherCode)();
        let tries = 0;
        while ((0, db_1.findVoucherByCode)(code) && tries < 50) {
            code = (0, utils_1.generateVoucherCode)();
            tries++;
        }
        const paidAt = (0, utils_1.nowString)();
        (0, db_1.updateOrderVoucher)(orderReference, code, paidAt);
        (0, db_1.createVoucher)(code, order.phone, order.package_name, order.amount, pkg.mikrotik_profile, pkg.limit_uptime, orderReference);
        // Fire-and-forget SMS (disabled for now per user request)
        (0, sms_1.sendVoucherSms)(order.phone, code, pkg.label)
            .then(result => {
            (0, db_1.updateOrderSmsStatus)(orderReference, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
            (0, db_1.updateVoucherSmsStatus)(code, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
            (0, db_1.logSms)(order.phone, code, orderReference, result.sent, result.provider, result.response);
        })
            .catch(err => utils_1.logger.error('SMS', 'Async SMS failed', { error: err }));
        // Push to MikroTik — AWAITED (not fire-and-forget).
        // User's login link will fail if the hotspot user doesn't exist yet.
        try {
            const synced = await (0, mikrotik_1.pushVoucher)({
                code, package_name: order.package_name,
                mikrotik_profile: pkg.mikrotik_profile, limit_uptime: pkg.limit_uptime, order_reference: orderReference,
            });
            if (synced) {
                (0, db_1.markVoucherSynced)(code);
                utils_1.logger.info('Payment', `Voucher ${code} synced to MikroTik`);
            }
            else {
                utils_1.logger.warn('Payment', `Voucher ${code} NOT synced to MikroTik — user may need to retry`);
            }
        }
        catch (err) {
            utils_1.logger.error('MikroTik', 'pushVoucher threw', { code, error: err instanceof Error ? err.message : String(err) });
        }
        return { order: (0, db_1.findOrderByReference)(orderReference), voucher_code: code, created: true };
    }
    finally {
        processingOrders.delete(orderReference);
    }
}
exports.default = router;
//# sourceMappingURL=payments.js.map