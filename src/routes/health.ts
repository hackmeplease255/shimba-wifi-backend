import { Router, Request, Response } from 'express';
import { config } from '../config';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
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

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: 'SHIMBA WiFi backend is running',
    time: new Date().toISOString().replace('T', ' ').slice(0, 19),
    webhook_url: getWebhookUrl(),
  });
});

export function getWebhookUrl(): string {
  // Mongike requires HTTPS webhook URLs.
  // With a direct VPS IP, you need a domain + Nginx + SSL for this to work with Mongike.
  // Without SSL, Mongike will reject the webhook and no voucher will be issued automatically.
  // Ensure your webhook URL is HTTPS for Mongike to reach it.
  return `${config.publicBaseUrl}/api/mongike-webhook`;
}

router.get('/packages', (_req: Request, res: Response) => {
  res.json(config.packages);
});

export default router;
