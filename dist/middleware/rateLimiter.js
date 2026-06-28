"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookLimiter = exports.adminLimiter = exports.generalLimiter = exports.paymentLimiter = void 0;
/**
 * Rate limiting middleware.
 * Protects payment and admin endpoints from abuse.
 */
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
/** Strict rate limit for payment initiation (max 5 per IP per minute) */
exports.paymentLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    message: { success: false, message: 'Too many payment requests. Please wait a moment and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
});
/** Generous rate limit for general API endpoints (max 60 per IP per minute) */
exports.generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, message: 'Too many requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});
/** Strict rate limit for admin endpoints (max 20 per IP per minute) */
exports.adminLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 20,
    message: { success: false, message: 'Too many admin requests.' },
    standardHeaders: true,
    legacyHeaders: false,
});
/** Very strict rate limit for webhook (max 10 per IP per minute — avoid duplicate processing) */
exports.webhookLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many webhook calls.' },
    standardHeaders: true,
    legacyHeaders: false,
});
//# sourceMappingURL=rateLimiter.js.map