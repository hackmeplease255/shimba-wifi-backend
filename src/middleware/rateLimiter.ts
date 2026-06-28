/**
 * Rate limiting middleware.
 * Protects payment and admin endpoints from abuse.
 */
import rateLimit from 'express-rate-limit';

/** Strict rate limit for payment initiation (max 5 per IP per minute) */
export const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { success: false, message: 'Too many payment requests. Please wait a moment and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Generous rate limit for general API endpoints (max 60 per IP per minute) */
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Strict rate limit for admin endpoints (max 20 per IP per minute) */
export const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many admin requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Very strict rate limit for webhook (max 10 per IP per minute — avoid duplicate processing) */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many webhook calls.' },
  standardHeaders: true,
  legacyHeaders: false,
});


