"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Express application assembly.
 * Combines all middleware and route modules.
 */
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const rateLimiter_1 = require("./middleware/rateLimiter");
const health_1 = __importDefault(require("./routes/health"));
const payments_1 = __importDefault(require("./routes/payments"));
const webhook_1 = __importDefault(require("./routes/webhook"));
const hotspot_1 = __importDefault(require("./routes/hotspot"));
const admin_1 = __importDefault(require("./routes/admin"));
const app = (0, express_1.default)();
/* ── Trust proxy (required when behind a reverse proxy like Nginx) ── */
app.set('trust proxy', 1);
/* ── Global Middleware ── */
// Security headers
app.use((0, helmet_1.default)({
    contentSecurityPolicy: false, // Disabled for API — enable if serving HTML
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
// CORS — open for public API
app.use((0, cors_1.default)({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));
app.options('*', (0, cors_1.default)());
// Body parsing
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
// Global rate limiting
app.use(rateLimiter_1.generalLimiter);
/* ── Routes ── */
app.use('/', health_1.default);
app.use('/', payments_1.default);
app.use('/', webhook_1.default);
app.use('/', hotspot_1.default);
app.use('/', admin_1.default);
/* ── 404 handler ── */
app.use((_req, res) => {
    res.status(404).json({ success: false, message: 'Not found' });
});
/* ── Global error handler ── */
app.use((err, _req, res, _next) => {
    console.error('[Unhandled Error]', err);
    res.status(500).json({ success: false, message: 'Internal server error' });
});
exports.default = app;
//# sourceMappingURL=app.js.map