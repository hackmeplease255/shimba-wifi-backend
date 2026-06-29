import { Router, Request, Response } from 'express';
import { adminAuth, loginHandler } from '../middleware/auth';
import { adminLimiter } from '../middleware/rateLimiter';
import {
  getAllOrders, getStats, queryAll,
  createOrder, createVoucher, findVoucherByCode, updateOrderVoucher, markVoucherSynced,
  getConnectedUsers, getConnectedUsersCount, clearAllData,
  getDailyRevenue, getMonthlyRevenue, getAllCustomers, getSystemEvents,
  changeAdminPassword,
} from '../db';
import { validateOrderRef } from '../middleware/validation';
import { issueVoucherForOrder } from './payments';
import { getPackage, isValidPackage, config } from '../config';
import { nowString, makeOrderReference, generateVoucherCode, normalizePhone, isValidPhone, parseLimitUptime, logger } from '../utils';
import { pushVoucher } from '../mikrotik';

const router = Router();

/* ── Admin login (get JWT token) ── */
router.post('/api/admin/login', adminLimiter, loginHandler);

/* ── Dashboard stats ── */
router.get('/api/admin/stats', adminAuth, (_req: Request, res: Response) => {
  const stats = getStats();
  res.json({ success: true, ...stats });
});

/* ── List recent orders ── */
router.get('/api/admin/orders', adminAuth, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const orders = getAllOrders(limit);
  res.json({ success: true, orders });
});

/* ── Manually complete a stuck payment ── */
/* ── View recent webhook events (to debug Mongike format) ── */
router.get('/api/admin/webhook-events', adminAuth, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const events = queryAll('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?', [limit]);
  res.json({ success: true, events });
});

router.post('/api/admin/complete-order', adminAuth, validateOrderRef, async (req: Request, res: Response) => {
  const { order_reference } = req.body || {};
  if (!order_reference) {
    return res.status(400).json({ success: false, message: 'Tafadhali toa order_reference' });
  }

  try {
    const result = await issueVoucherForOrder(order_reference);
    res.json({
      success: true,
      message: 'Vocha imetengenezwa!',
      voucher_code: result.voucher_code,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ── List vouchers ── */
router.get('/api/admin/vouchers', adminAuth, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const vouchers = queryAll('SELECT * FROM vouchers ORDER BY id DESC LIMIT ?', [limit]);
  res.json({ success: true, vouchers });
});

/* ── Connected users (real-time, enriched with voucher data) ── */
router.get('/api/admin/connected-users', adminAuth, (_req: Request, res: Response) => {
  const users = getConnectedUsers();
  const count = getConnectedUsersCount();

  // Enrich each user with voucher data (phone, amount, status, remaining time)
  const enriched = users.map(u => {
    const voucher = u.code ? findVoucherByCode(u.code) : null;
    let remainingMs = 0;
    let remainingLabel = '';
    if (voucher) {
      const maxMs = parseLimitUptime(voucher.limit_uptime);
      if (maxMs > 0 && u.login_at) {
        const elapsed = Date.now() - new Date(u.login_at).getTime();
        remainingMs = Math.max(0, maxMs - elapsed);
        const mins = Math.floor(remainingMs / 60000);
        if (mins >= 1440) remainingLabel = `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
        else if (mins >= 60) remainingLabel = `${Math.floor(mins / 60)}h ${mins % 60}m`;
        else remainingLabel = `${mins}m`;
      }
    }
    return {
      user: u.user,
      code: u.code,
      mac: u.mac,
      ip: u.ip,
      package_name: u.package_name || '',
      login_at: u.login_at || '',
      phone: (voucher?.phone && voucher.phone !== 'ADMIN_CASH') ? voucher.phone : '',
      amount: voucher?.amount || 0,
      voucher_status: voucher?.status || '',
      remaining: remainingLabel,
      remaining_ms: remainingMs,
      login_since: u.login_at ? Math.floor((Date.now() - new Date(u.login_at).getTime()) / 60000) : 0,
    };
  });

  res.json({ success: true, users: enriched, totalUnique: count });
});

/* ── Clear all data (reset for new client) ── */
router.post('/api/admin/clear-data', adminAuth, (req: Request, res: Response) => {
  const { confirm } = req.body || {};
  if (confirm !== 'RESET_ALL_DATA') {
    return res.status(400).json({
      success: false,
      message: 'Tafadhali tuma confirm="RESET_ALL_DATA" kuthibitisha.',
    });
  }

  clearAllData();
  logger.info('Admin', 'All data cleared by admin');
  res.json({ success: true, message: 'Data zote zimefutwa kikamilifu!' });
});

/* ── Daily revenue (for charts) ── */
router.get('/api/admin/daily-revenue', adminAuth, (req: Request, res: Response) => {
  const days = Math.min(Number(req.query.days) || 14, 90);
  const revenue = getDailyRevenue(days);
  res.json({ success: true, revenue });
});

/* ── Monthly revenue (for charts) ── */
router.get('/api/admin/monthly-revenue', adminAuth, (req: Request, res: Response) => {
  const months = Math.min(Number(req.query.months) || 12, 36);
  const revenue = getMonthlyRevenue(months);
  res.json({ success: true, revenue });
});

/* ── Customers list ── */
router.get('/api/admin/customers', adminAuth, (_req: Request, res: Response) => {
  const customers = getAllCustomers();
  res.json({ success: true, customers });
});

/* ── System events / logs ── */
router.get('/api/admin/system-events', adminAuth, (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const events = getSystemEvents(limit);
  res.json({ success: true, events });
});

/* ── System health (admin version) ── */
router.get('/api/admin/system-info', adminAuth, (_req: Request, res: Response) => {
  res.json({
    success: true,
    version: '2.0.0',
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
    memory: process.memoryUsage(),
    platform: process.platform,
    timestamp: new Date().toISOString(),
  });
});

/* ── Change admin password ── */
router.post('/api/admin/change-password', adminAuth, (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Tafadhali toa currentPassword na newPassword' });
  }

  if (newPassword.length < 4) {
    return res.status(400).json({ success: false, message: 'Password mpya inahitaji angalau herufi 4' });
  }

  // Verify current password against config (env) or DB
  const dbPassword = getAdminPassword();
  const currentValid =
    currentPassword === config.admin.password ||
    (dbPassword && currentPassword === dbPassword);

  if (!currentValid) {
    return res.status(401).json({ success: false, message: 'Password ya sasa si sahihi' });
  }

  changeAdminPassword(newPassword);
  logger.info('Admin', 'Password changed by admin');
  res.json({ success: true, message: 'Password imebadilishwa kikamilifu!' });
});

/* ── Admin: Create voucher manually (without payment) ── */
router.post('/api/admin/create-voucher', adminAuth, async (req: Request, res: Response) => {
  const { phone, package_name } = req.body || {};

  if (!package_name || !isValidPackage(package_name)) {
    return res.status(400).json({ success: false, message: 'Tafadhali toa package sahihi (6hours, 24hours, 48hours, 7days)' });
  }

  // Phone is optional — admin may give voucher directly without recording phone
  const normalizedPhone = phone ? normalizePhone(phone) : 'ADMIN_CASH';
  if (phone && !isValidPhone(normalizedPhone)) {
    return res.status(400).json({ success: false, message: 'Namba ya simu si sahihi. Tumia format: 07xxxxxxxx au 06xxxxxxxx' });
  }

  try {
    const pkg = getPackage(package_name)!;
    const orderReference = makeOrderReference();

    // Create payment order (marked as SUCCESS, admin-created)
    createOrder(orderReference, normalizedPhone, package_name, pkg.amount);

    // Create voucher directly
    let code = generateVoucherCode();
    let tries = 0;
    while (findVoucherByCode(code) && tries < 50) {
      code = generateVoucherCode();
      tries++;
    }

    const paidAt = nowString();
    updateOrderVoucher(orderReference, code, paidAt);
    createVoucher(code, normalizedPhone, package_name, pkg.amount,
      pkg.mikrotik_profile, pkg.limit_uptime, orderReference);

    // Try to push to MikroTik
    try {
      const synced = await pushVoucher({
        code, package_name,
        mikrotik_profile: pkg.mikrotik_profile, limit_uptime: pkg.limit_uptime, order_reference: orderReference,
      });
      if (synced) {
        markVoucherSynced(code);
        logger.info('Admin', `Voucher ${code} created and synced to MikroTik by admin`);
      } else {
        logger.info('Admin', `Voucher ${code} created by admin (will sync via .rsc)`);
      }
    } catch (err) {
      logger.warn('Admin', `Voucher ${code} created by admin but push failed (will sync via .rsc)`);
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
  } catch (e: any) {
    logger.error('Admin', 'Failed to create voucher', { error: e.message });
    res.status(500).json({ success: false, message: 'Imeshindikana kutengeneza vocha: ' + e.message });
  }
});

export default router;
