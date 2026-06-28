import { Router, Request, Response } from 'express';
import axios from 'axios';
import { config, getPackage } from '../config';
import {
  findOrderByReference, findOrdersByPhone,
  createOrder, updateOrderStatus, updateOrderVoucher,
  createVoucher, markVoucherSynced, findVoucherByCode,
  updateOrderSmsStatus, updateVoucherSmsStatus, logSms,
} from '../db';
import {
  nowString, makeOrderReference, generateVoucherCode, normalizePhone,
  isValidPhone, normalizeStatus, logger,
} from '../utils';
import { pushVoucher } from '../mikrotik';
import { sendVoucherSms } from '../sms';
import { validatePayRequest, validateOrderRef } from '../middleware/validation';
import { paymentLimiter } from '../middleware/rateLimiter';
import { getWebhookUrl } from './health';

const router = Router();

/* ── Initiate payment ── */
router.post('/pay-mongike', paymentLimiter, validatePayRequest, async (req: Request, res: Response) => {
  const { phone, package_name, amount } = req.body;
  const pkg = getPackage(package_name);
  if (!pkg) {
    return res.status(400).json({ success: false, message: 'Invalid package' });
  }

  if (!config.mongike.apiKey) {
    return res.status(500).json({ success: false, message: 'Mongike API key haijawekwa' });
  }

  const orderReference = makeOrderReference();
  createOrder(orderReference, phone, package_name, amount);

  try {
    const webhookUrl = getWebhookUrl();
    logger.info('Payment', `Initiating order ${orderReference}`, { amount, phone, webhookUrl });

    await axios.post(
      `${config.mongike.baseUrl}${config.mongike.paymentEndpoint}`,
      {
        order_id: orderReference,
        amount: pkg.amount,
        buyer_phone: phone,
        fee_payer: 'MERCHANT',
        webhook_url: webhookUrl,
      },
      {
        headers: {
          'x-api-key': config.mongike.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    res.json({
      success: true,
      orderReference,
      message: 'Payment request sent. Angalia simu yako na thibitisha PIN.',
      status: 'PROCESSING',
    });
  } catch (error: any) {
    const errorMessage = error.response?.data?.message || error.response?.data || error.message;
    logger.error('Payment', 'Mongike request failed', { orderReference, error: errorMessage });

    updateOrderStatus(orderReference, 'FAILED', 'payment_failed',
      typeof errorMessage === 'string' ? errorMessage : JSON.stringify(errorMessage));

    res.status(500).json({
      success: false,
      message: 'Payment request failed. Tafadhali jaribu tena.',
      error: errorMessage,
    });
  }
});

/* ── Check payment status (READ-ONLY — never issues vouchers) ── */
router.get('/payment-status/:orderReference', validateOrderRef, async (req: Request, res: Response) => {
  const orderReference = String(req.params.orderReference);
  const order = findOrderByReference(orderReference);

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
router.get('/api/latest-voucher', async (req: Request, res: Response) => {
  const phone = normalizePhone(String(req.query.phone ?? ''));
  const packageName = String(req.query.package_name ?? '').trim();

  if (!isValidPhone(phone)) {
    return res.status(400).json({ success: false, message: 'Invalid phone' });
  }

  const orders = findOrdersByPhone(phone, packageName || undefined)
    .filter(o => o.voucher_code)
    .sort((a, b) => b.id - a.id);

  const order = orders[0];
  if (!order) {
    return res.status(404).json({ success: false, message: 'No paid voucher found for this phone' });
  }

  const voucher = findVoucherByCode(order.voucher_code!);
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
router.get('/api/order-voucher/:orderReference', validateOrderRef, (req: Request, res: Response) => {
  const orderReference = String(req.params.orderReference || '').trim();
  const order = findOrderByReference(orderReference);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }
  if (!order.voucher_code) {
    return res.status(404).json({ success: false, message: 'Voucher not ready' });
  }

  const voucher = findVoucherByCode(order.voucher_code);
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
router.get('/api/voucher-status/:code', (req: Request, res: Response) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const voucher = findVoucherByCode(code);
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
router.post('/api/resend-sms', async (req: Request, res: Response) => {
  const { order_reference } = req.body || {};
  if (!order_reference) {
    return res.status(400).json({ success: false, message: 'Toa order_reference' });
  }

  const order = findOrderByReference(order_reference);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order haijapatikana' });
  }
  if (!order.voucher_code) {
    return res.status(400).json({ success: false, message: 'Order hii haina voucher bado' });
  }

  const pkg = getPackage(order.package_name);
  try {
    const result = await sendVoucherSms(order.phone, order.voucher_code, pkg?.label || order.package_name);
    updateOrderSmsStatus(order_reference, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
    updateVoucherSmsStatus(order.voucher_code, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
    logSms(order.phone, order.voucher_code, order_reference, result.sent, result.provider, result.response);
    res.json({ success: true, sent: result.sent, provider: result.provider, response: result.response });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ── Test SMS ── */
router.post('/api/test-sms', async (req: Request, res: Response) => {
  const phone = String(req.body?.phone || '0745416143').trim();
  const packageName = String(req.body?.packageName || '24 Hours').trim();
  const code = String(req.body?.code || 'TEST123').trim().toUpperCase();

  logger.info('SMS Test', `Testing SMS to ${phone}, code: ${code}, package: ${packageName}`);

  try {
    const result = await sendVoucherSms(phone, code, packageName);
    res.json({
      success: true,
      sent: result.sent,
      provider: result.provider,
      response: result.response,
      phone: normalizePhone(phone),
      debug: {
        SMS_ENABLED: config.sms.enabled,
        SMS_PROVIDER: config.sms.provider,
        SMS_API_URL: config.sms.apiUrl || 'NOT SET',
        SMS_SENDER: config.sms.sender,
      },
    });
  } catch (error: any) {
    logger.error('SMS Test', 'Error', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
      debug: {
        SMS_ENABLED: config.sms.enabled,
        SMS_PROVIDER: config.sms.provider,
        SMS_API_URL: config.sms.apiUrl || 'NOT SET',
        SMS_SENDER: config.sms.sender,
      },
    });
  }
});

/* ── In-memory lock to prevent double voucher creation from concurrent webhooks ── */
const processingOrders = new Set<string>();

/* ── Shared helper: issue voucher for a paid order ── */
export async function issueVoucherForOrder(orderReference: string) {
  // Lock to prevent concurrent voucher creation for the same order
  if (processingOrders.has(orderReference)) {
    logger.info('Payment', `Order ${orderReference} already being processed — waiting...`);
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
    const order = findOrderByReference(orderReference);
    if (!order) throw new Error('Order not found');
    if (order.voucher_code) {
      return { order, voucher_code: order.voucher_code, created: false };
    }

  const pkg = getPackage(order.package_name);
  if (!pkg) throw new Error('Invalid package for order');

  // Generate unique voucher code
  let code = generateVoucherCode();
  let tries = 0;
  while (findVoucherByCode(code) && tries < 50) {
    code = generateVoucherCode();
    tries++;
  }

  const paidAt = nowString();
  updateOrderVoucher(orderReference, code, paidAt);
  createVoucher(code, order.phone, order.package_name, order.amount,
    pkg.mikrotik_profile, pkg.limit_uptime, orderReference);

  // Fire-and-forget SMS (disabled for now per user request)
  sendVoucherSms(order.phone, code, pkg.label)
    .then(result => {
      updateOrderSmsStatus(orderReference, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
      updateVoucherSmsStatus(code, result.sent, result.provider, result.sent ? 'SENT' : 'FAILED');
      logSms(order.phone, code, orderReference, result.sent, result.provider, result.response);
    })
    .catch(err => logger.error('SMS', 'Async SMS failed', { error: err }));

  // Push to MikroTik — AWAITED (not fire-and-forget).
  // User's login link will fail if the hotspot user doesn't exist yet.
  try {
    const synced = await pushVoucher({
      code, package_name: order.package_name,
      mikrotik_profile: pkg.mikrotik_profile, limit_uptime: pkg.limit_uptime, order_reference: orderReference,
    });
    if (synced) {
      markVoucherSynced(code);
      logger.info('Payment', `Voucher ${code} synced to MikroTik`);
    } else {
      logger.warn('Payment', `Voucher ${code} NOT synced to MikroTik — user may need to retry`);
    }
  } catch (err) {
    logger.error('MikroTik', 'pushVoucher threw', { code, error: err instanceof Error ? err.message : String(err) });
  }

  return { order: findOrderByReference(orderReference), voucher_code: code, created: true };
  } finally {
    processingOrders.delete(orderReference);
  }
}

export default router;
