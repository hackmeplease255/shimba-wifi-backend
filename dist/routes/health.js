"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWebhookUrl = getWebhookUrl;
const express_1 = require("express");
const config_1 = require("../config");
const router = (0, express_1.Router)();
router.get('/', (_req, res) => {
    res.json({
        success: true,
        name: 'SHIMBA WIFI API',
        status: 'online',
        time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        version: '2.0.0',
        endpoints: [
            '/health',
            '/packages',
            '/pay-mongike',
            '/payment-status/:orderReference',
            '/api/voucher-status/:code',
            '/api/mongike-webhook',
            '/api/admin/*',
        ],
    });
});
router.get('/health', (_req, res) => {
    res.json({
        success: true,
        message: 'SHIMBA WiFi backend is running',
        time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        webhook_url: getWebhookUrl(),
    });
});
function getWebhookUrl() {
    // Mongike requires HTTPS webhook URLs.
    // With a direct VPS IP, you need a domain + Nginx + SSL for this to work with Mongike.
    // Without SSL, Mongike will reject the webhook and no voucher will be issued automatically.
    // Ensure your webhook URL is HTTPS for Mongike to reach it.
    return `${config_1.config.publicBaseUrl}/api/mongike-webhook`;
}
router.get('/packages', (_req, res) => {
    res.json(config_1.config.packages);
});
exports.default = router;
//# sourceMappingURL=health.js.map