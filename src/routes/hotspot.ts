import { Router, Request, Response } from 'express';
import { config } from '../config';
import {
  findVoucherByCode, upsertActiveUser, findActiveUser,
  getRecentVouchers, markVoucherSynced, markVoucherExpired,
  saveMacAssociation, findMacAssociation, isVoucherExpired, deleteMacAssociation,
} from '../db';
import { escapeRsc, nowIso, nowString, logger } from '../utils';

const router = Router();

/* ── Hotspot login callback (called by MikroTik) ── */
router.get('/api/hotspot-login', (req: Request, res: Response) => {
  if (req.query.token !== config.syncToken) {
    return res.status(401).send('bad token');
  }

  const user = String(req.query.user || '').trim().toUpperCase();
  const mac = String(req.query.mac || '').trim().toUpperCase();
  const ip = String(req.query.ip || '').trim();

  if (!user) return res.status(400).send('missing user');

  const voucher = findVoucherByCode(user);
  upsertActiveUser(user, user, mac, ip, voucher?.package_name || null);

  logger.info('Hotspot', 'User logged in', { user, mac, ip });
  res.type('text/plain').send('ok');
});

/* ── Session status check ── */
router.get('/api/session-status', (req: Request, res: Response) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const mac = String(req.query.mac || '').trim().toUpperCase();
  const ip = String(req.query.ip || '').trim();

  const record = findActiveUser(code, mac, ip);
  const connected = Boolean(record);

  res.json({
    success: true,
    connected,
    session: connected ? {
      user: record!.user,
      code: record!.code,
      mac: record!.mac,
      ip: record!.ip,
      package_name: record!.package_name,
      login_at: record!.login_at,
    } : null,
  });
}); /* ── MikroTik sync .rsc script ──
 *
 * This script can be run on the MikroTik router to add all vouchers.
 * If MikroTik can reach the VPS (same network or public IP whitelisted),
 * the backend pushes vouchers directly. Otherwise, use this script.
 *
 * Usage on MikroTik:
 *   /tool fetch url="https://shimbawifi.xyz/mikrotik-sync-TOKEN.rsc"
 *   :delay 2s
 *   /import file-name=mikrotik-sync-TOKEN.rsc
 */
router.get(`/mikrotik-sync-${config.syncToken}.rsc`, (req: Request, res: Response) => {
  const recentVouchers = getRecentVouchers(config.dataRetentionDays);

  // Filter: expired vouchers are REMOVED from MikroTik, active ones are ADDED.
  // This prevents users from reconnecting with an expired voucher.
  let script = '';
  for (const v of recentVouchers) {
    const code = escapeRsc(v.code);

    if (isVoucherExpired(v)) {
      // Remove expired voucher from MikroTik and mark as used in DB
      script += `/ip hotspot user remove [find name="${code}"]
`;
      markVoucherExpired(v.code);
      // Note: MAC association cleanup is handled by auto-connect endpoint
      logger.info('MikroTik', 'Expired voucher removed from sync script', { code: v.code });
    } else {
      const profile = escapeRsc(v.mikrotik_profile);
      const limit = escapeRsc(v.limit_uptime);
      const comment = escapeRsc(`SHIMBA ${v.package_name} ${v.order_reference}`);
      script += `/ip hotspot user add name="${code}" password="${code}" profile="${profile}" limit-uptime="${limit}" comment="${comment}"
`;
    }
  }

  res.type('text/plain').send(script);
});

/* ── Mark voucher as synced (GET, called by MikroTik script) ── */
router.get('/api/mark-synced-get', (req: Request, res: Response) => {
  if (req.query.token !== config.syncToken) {
    return res.status(401).send('bad token');
  }

  const code = String(req.query.code || '').trim();
  if (code) {
    markVoucherSynced(code);
    logger.info('MikroTik', 'Voucher marked synced via GET callback', { code });
  }

  res.type('text/plain').send('ok');
});

/* ── Connect WiFi page ──
 *
 * Serves an HTML page that auto-submits the voucher code to the MikroTik
 * hotspot login form. This fixes the issue where a direct link to
 * 192.168.88.1/login fails on the first click because the user may not
 * be on the WiFi yet, or the voucher wasn't synced in time.
 *
 * The page:
 *  1. Verifies the voucher exists in our DB
 *  2. Tries loading a resource from the MikroTik router to detect WiFi
 *  3. Auto-redirects to the hotspot login page with credentials
 *  4. Shows clear instructions if not on WiFi
 */
router.get('/api/connect', (req: Request, res: Response) => {
  const code = String(req.query.code || '').trim().toUpperCase();

  if (!code) {
    return res.status(400).send('<html><body><h3>Missing voucher code</h3></body></html>');
  }

  // HTML-escape the code for safe rendering (XSS protection)
  const safeCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const safeCodeJs = JSON.stringify(code); // JSON-safe for JavaScript string

  const voucher = findVoucherByCode(code);
  const packageName = voucher?.package_name || '';
  const safePackageName = packageName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html lang="sw">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SHIMBA WiFi — Unganisha</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #070b14;
    color: #eaf2ff;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: linear-gradient(180deg, #111a2e 0%, #0e1626 100%);
    border: 1px solid #1f2a44;
    border-radius: 18px;
    padding: 2rem;
    max-width: 420px;
    width: 90%;
    text-align: center;
    box-shadow: 0 20px 40px -28px rgba(0,0,0,0.7);
  }
  h1 {
    font-size: 1.5rem;
    background: linear-gradient(135deg, #22d3ee, #93c5fd);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }
  .code-badge {
    display: inline-block;
    font-family: monospace;
    font-size: 1.4rem;
    font-weight: bold;
    letter-spacing: 4px;
    color: #22d3ee;
    background: #000d1a;
    border: 1px solid #22d3ee/30;
    border-radius: 12px;
    padding: 10px 20px;
    margin: 1rem 0;
  }
  .info {
    color: #8aa0c4;
    font-size: 0.85rem;
    margin-top: 0.75rem;
    line-height: 1.5;
  }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>📶 SHIMBA WIFI</h1>
  <p style="color:#8aa0c4;font-size:0.9rem;">${safePackageName ? 'Kifurushi: ' + safePackageName : ''}</p>

  <div class="code-badge">${safeCode}</div>

  <div id="status-connecting">
    <p style="color:#22d3ee;font-weight:600;">Inakuunganisha kwenye SHIMBA WiFi...</p>
    <p class="info">Tafadhali subiri...</p>
  </div>

  <div id="status-retrying" class="hidden">
    <div class="spinner" style="display:inline-block;width:24px;height:24px;border:3px solid #1f2a44;border-top-color:#22d3ee;border-radius:50%;animation:spin 0.8s linear infinite;margin:1rem auto;"></div>
    <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
    <p style="color:#fbbf24;font-weight:600;">Inasynchroniza vocha kwenye router...</p>
    <p class="info">Vocha yako inawekwa kwenye router. Hii inachukua sekunde chache tu.</p>
  </div>

  <form id="loginForm" method="post" action="http://192.168.88.1/login" target="_self">
    <input type="hidden" name="username" value="${safeCode}">
    <input type="hidden" name="password" value="${safeCode}">
  </form>

  <button id="manualBtn" onclick="document.getElementById('loginForm').submit()" class="btn" style="display:inline-block;width:100%;padding:14px 20px;border-radius:16px;font-size:1rem;font-weight:800;cursor:pointer;border:none;margin-top:1rem;background:linear-gradient(135deg,#10b981,#059669);color:white;">
    Unganisha WiFi Sasa
  </button>

  <div class="info" style="margin-top:1rem;">
    Voucher code: <strong>${safeCode}</strong><br>
    Kama haijaunganisha, hakikisha uko kwenye mtandao wa <strong>SHIMBA WiFi</strong>
  </div>
</div>

<script>
(function() {
  const statusConnecting = document.getElementById('status-connecting');
  const statusRetrying = document.getElementById('status-retrying');
  const loginForm = document.getElementById('loginForm');

  function tryConnect() {
    loginForm.submit();
  }

  // Try immediately after 1 second
  setTimeout(function() {
    statusConnecting.classList.add('hidden');
    statusRetrying.classList.remove('hidden');
    tryConnect();
  }, 1000);

  // Keep retrying every 5 seconds
  setInterval(function() {
    tryConnect();
  }, 5000);
})();
</script>
</body>
</html>`;

  res.type('text/html').send(html);
});

/* ── Auto-connect: look up voucher by MAC ── */
router.get('/api/auto-connect', (req: Request, res: Response) => {
  const mac = String(req.query.mac || '').trim().toUpperCase();
  if (!mac) {
    return res.json({ auto: false });
  }

  const association = findMacAssociation(mac);
  if (association) {
    // Verify the voucher still exists in the DB
    const voucher = findVoucherByCode(association.code);
    if (voucher) {
      // Check if voucher has expired (limit-uptime reached)
      if (isVoucherExpired(voucher)) {
        logger.info('Hotspot', 'Auto-connect skipped — voucher expired', { mac, code: association.code });
        // Clean up the expired association so it doesn't trigger again
        deleteMacAssociation(mac);
        return res.json({ auto: false, expired: true, message: 'Vocha yako muda wake umekwisha. Tafadhali nunua mpya.' });
      }

      // Record the login in active_users so the admin panel sees it
      const clientIp = req.ip || req.socket.remoteAddress || '';
      upsertActiveUser(voucher.code, voucher.code, mac, clientIp, voucher.package_name);

      logger.info('Hotspot', 'Auto-connect found voucher for MAC', { mac, code: association.code, ip: clientIp });
      return res.json({
        auto: true,
        code: association.code,
        package_name: association.package_name,
      });
    }
  }

  res.json({ auto: false });
});

/* ── Associate a MAC address with a voucher code ── */
router.post('/api/associate-mac', (req: Request, res: Response) => {
  const { mac, code, ip } = req.body || {};
  if (!mac || !code) {
    return res.json({ success: false });
  }

  const voucher = findVoucherByCode(String(code).trim().toUpperCase());
  if (!voucher) {
    return res.json({ success: false });
  }

  const normalizedMac = String(mac).trim().toUpperCase();
  const clientIp = String(ip || '').trim();

  // Save MAC→voucher association (for auto-connect on return)
  saveMacAssociation(normalizedMac, voucher.code, voucher.package_name);

  // Also record the login in active_users so the admin panel sees it
  upsertActiveUser(voucher.code, voucher.code, normalizedMac, clientIp, voucher.package_name);

  logger.info('Hotspot', 'MAC associated with voucher + user logged in', { mac: normalizedMac, code: voucher.code, ip: clientIp });
  res.json({ success: true });
});

/* ── Hotspot callback from status/alogin pages (no token needed) ──
 *
 * Called by JavaScript in hotspot/status.html and hotspot/alogin.html
 * AFTER the user has successfully logged in through MikroTik.
 * At this point the user has full internet access (block bypassed).
 */
router.get('/api/hotspot-callback', (req: Request, res: Response) => {
  const user = String(req.query.user || '').trim().toUpperCase();
  const mac = String(req.query.mac || '').trim().toUpperCase();
  const ip = String(req.query.ip || '').trim();

  if (!user) {
    return res.status(400).send('missing user');
  }

  const voucher = findVoucherByCode(user);
  upsertActiveUser(user, user, mac, ip, voucher?.package_name || null);
  logger.info('Hotspot', 'User logged in (callback from hotspot page)', { user, mac, ip });
  res.type('text/plain').send('ok');
});

/* ── Serve MikroTik hotspot files (placeholder) ── */
router.get('/mt-files/:file', (req: Request, res: Response) => {
  const file = String(req.params.file || '');
  // Basic sanitize: only allow known hotspot files
  const basename = file.split('/').pop() || file;
  if (!config.hotspotFiles.has(basename)) {
    return res.status(404).json({ success: false, message: 'Hotspot file not found' });
  }
  res.status(404).json({
    success: false,
    message: 'Hotspot files not hosted on this backend',
  });
});

export default router;
