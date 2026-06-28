/**
 * Express application assembly.
 * Combines all middleware and route modules.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generalLimiter } from './middleware/rateLimiter';
import healthRoutes from './routes/health';
import paymentRoutes from './routes/payments';
import webhookRoutes from './routes/webhook';
import hotspotRoutes from './routes/hotspot';
import adminRoutes from './routes/admin';

const app = express();

/* ── Trust proxy (required when behind a reverse proxy like Nginx) ── */
app.set('trust proxy', 1);

/* ── Global Middleware ── */

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for API — enable if serving HTML
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// CORS — open for public API
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

app.options('*', cors());

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiting
app.use(generalLimiter);

/* ── Routes ── */
app.use('/', healthRoutes);
app.use('/', paymentRoutes);
app.use('/', webhookRoutes);
app.use('/', hotspotRoutes);
app.use('/', adminRoutes);

/* ── 404 handler ── */
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

/* ── Global error handler ── */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

export default app;
