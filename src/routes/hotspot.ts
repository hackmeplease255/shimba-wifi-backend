import { Router, Request, Response } from 'express';
import { config } from '../config';
import {
  findVoucherByCode, upsertActiveUser, findActiveUser,
  getRecentVouchers, markVoucherSynced, markVoucherExpired,
  saveMacAssociation, findMacAssociation, isVoucherExpired, deleteMacAssociation,
  queryAll, reportActiveSessions, getPendingDisconnects, removePendingDisconnect, clearPendingDisconnects,
} from '../db';
import { escapeRsc, nowIso, nowString, logger } from '../utils';
import { pushVoucher } from '../mikrotik';

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
  let script = '';

  // ── Pending disconnects (admin force-logout) ──
  const pendingDisconnects = getPendingDisconnects();
  for (const code of pendingDisconnects) {
    const safeCode = escapeRsc(code);
    script += `/ip hotspot user remove [find name="${safeCode}"]
`;
    script += `/ip hotspot active remove [find user="${safeCode}"]
`;
    removePendingDisconnect(code);
  }

  // ── Voucher sync (add new, remove expired) ──
  const recentVouchers = getRecentVouchers(config.dataRetentionDays);
  for (const v of recentVouchers) {
    const code = escapeRsc(v.code);

    if (isVoucherExpired(v)) {
      // Kill active session + remove expired voucher from MikroTik, mark as used in DB
      script += `/ip hotspot active remove [find user="${code}"]
`;
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

/* ── Associate a MAC address with a voucher code (GET — for alogin.html fallback) ── */
router.get('/api/associate-mac', (req: Request, res: Response) => {
  const mac = String(req.query.mac || '').trim().toUpperCase();
  const code = String(req.query.code || '').trim().toUpperCase();
  const ip = String(req.query.ip || '').trim();
  if (!mac || !code) {
    return res.json({ success: false });
  }
  const voucher = findVoucherByCode(code);
  if (!voucher) {
    return res.json({ success: false, message: 'Voucher not found' });
  }
  saveMacAssociation(mac, voucher.code, voucher.package_name);
  upsertActiveUser(voucher.code, voucher.code, mac, ip, voucher.package_name);
  logger.info('Hotspot', 'MAC associated via GET (for alogin fallback)', { mac, code: voucher.code, ip });
  res.json({ success: true });
});

/* ── Associate a MAC address with a voucher code (POST — for portal) ── */
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
 *
 * If MAC is empty (some MikroTik versions), tries to get it from
 * an existing MAC association for this voucher code.
 */
router.get('/api/hotspot-callback', (req: Request, res: Response) => {
  const user = String(req.query.user || '').trim().toUpperCase();
  let mac = String(req.query.mac || '').trim().toUpperCase();
  const ip = String(req.query.ip || '').trim();

  if (!user) {
    return res.status(400).send('missing user');
  }

  // If MAC is empty, try to find it from active_users records for this user
  if (!mac) {
    const rows = queryAll('SELECT mac FROM active_users WHERE user = ? AND mac IS NOT NULL AND mac != ? ORDER BY updated_at DESC LIMIT 1', [user, '']);
    if (rows.length > 0 && rows[0].mac && String(rows[0].mac).trim() !== '') {
      mac = String(rows[0].mac).toUpperCase();
    }
  }

  const voucher = findVoucherByCode(user);
  upsertActiveUser(user, user, mac, ip, voucher?.package_name || null);
  logger.info('Hotspot', 'User logged in (callback from hotspot page)', { user, mac, ip });
  res.type('text/plain').send('ok');
});

/* ── Auto-login: prepare voucher for MikroTik + authenticate ──
 *
 * Called by the frontend BEFORE redirecting to MikroTik login.
 * This ensures:
 *   1. The voucher exists in MikroTik hotspot users (push if not synced)
 *   2. The MAC association is saved (for future auto-reconnect)
 *   3. The login is recorded in active_users
 *   4. Returns the MikroTik login URL for redirect
 *
 * This is the KEY endpoint for making auto-reconnect seamless:
 *   - BEFORE redirect: call this to push voucher to MikroTik
 *   - AFTER login: status.html calls hotspot-callback
 *
 * Query params:
 *   code (required): voucher code
 *   mac  (optional): device MAC address
 *   ip   (optional): device IP address
 */
router.get('/api/auto-login', async (req: Request, res: Response) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const mac = String(req.query.mac || '').trim().toUpperCase();
  const ip = String(req.query.ip || '').trim();

  if (!code) {
    return res.json({ auto: false, reason: 'missing_code' });
  }

  // 1. Find the voucher
  const voucher = findVoucherByCode(code);
  if (!voucher) {
    return res.json({ auto: false, reason: 'not_found', message: 'Vocha haijapatikana' });
  }

  // 2. Check if expired
  if (isVoucherExpired(voucher)) {
    markVoucherExpired(code);
    return res.json({ auto: false, reason: 'expired', message: 'Vocha yako muda wake umekwisha' });
  }

  // 3. If voucher is not synced, try to push to MikroTik NOW
  let synced = !!voucher.synced;
  if (!synced) {
    try {
      const pushed = await pushVoucher({
        code, package_name: voucher.package_name,
        mikrotik_profile: voucher.mikrotik_profile, limit_uptime: voucher.limit_uptime,
        order_reference: voucher.order_reference,
      });
      if (pushed) {
        markVoucherSynced(code);
        synced = true;
        logger.info('Hotspot', 'Auto-login: Voucher pushed to MikroTik', { code });
      }
    } catch (err) {
      logger.warn('Hotspot', 'Auto-login: Failed to push voucher (will try .rsc)', { code, error: String(err) });
    }
  }

  // 4. Save MAC association (for future auto-reconnect lookups)
  if (mac) {
    saveMacAssociation(mac, code, voucher.package_name);
  }

  // 5. Record in active_users
  upsertActiveUser(code, code, mac, ip, voucher.package_name);
  logger.info('Hotspot', 'Auto-login: User authenticated', { code, mac, ip, synced });

  // 6. Return success with login URL
  const loginUrl = `http://192.168.88.1/login?username=${encodeURIComponent(code)}&password=${encodeURIComponent(code)}`;
  res.json({
    auto: true,
    code,
    package_name: voucher.package_name,
    synced,
    login_url: loginUrl,
    message: 'Vocha ni halali! Unaelekezwa kwenye WiFi...',
  });
});

/* ── Serve MikroTik hotspot files ──
 *
 * These HTML files are served from the backend so the user can download
 * them to MikroTik using:
 *   /tool fetch url="https://shimbawifi.xyz/mt-files/status.html"
 *   /tool fetch url="https://shimbawifi.xyz/mt-files/alogin.html"
 *   /tool fetch url="https://shimbawifi.xyz/mt-files/login.html"
 *
 * The status.html and alogin.html include JavaScript that calls
 * /api/hotspot-callback AFTER the user authenticates (when internet
 * is available), recording the login in active_users.
 */

const HOTSPOT_FILES: Record<string, string> = {
  'status.html': `<!DOCTYPE html>
<html>
<head><title>SHIMBA WIFI — Connected</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(180deg,#070b14,#0b1220);color:#eaf2ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}
.container{max-width:420px;width:100%}
.icon{font-size:48px;margin-bottom:12px}
h1{font-size:22px;font-weight:900;margin-bottom:8px}
.badge{display:inline-block;padding:4px 16px;border-radius:20px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#6ee7b7;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:20px}
.card{background:rgba(17,26,46,0.8);border:1px solid #1f2a44;border-radius:16px;padding:16px;text-align:left;margin-bottom:16px}
.row{display:flex;justify-content:space-between;padding:8px 0;font-size:13px}
.row:not(:last-child){border-bottom:1px solid rgba(31,42,68,0.5)}
.lbl{color:#6b7fa0}
.val{color:#eaf2ff;font-weight:600}
.btn{display:block;padding:12px 20px;border-radius:12px;border:none;background:linear-gradient(135deg,#22d3ee,#3b82f6);color:#001018;font-size:15px;font-weight:800;cursor:pointer;text-decoration:none;margin-top:8px}
.btno{background:transparent;border:1px solid #1f2a44;color:#8aa0c4}
.ft{font-size:11px;color:#4a5f80;margin-top:24px}
</style></head>
<body><div class="container">
$(if error == "already-logged-in")
<div class="icon">\uD83D\uDD04</div><h1>Tayari Umeingia</h1><p style="color:#8aa0c4;font-size:14px;margin-bottom:16px">You are already connected.</p>
$(else)
<div class="icon">\u2705</div><h1>Umeingia!</h1><div class="badge">Connected</div>
$(endif)
<div class="card">
<div class="row"><span class="lbl">Voucher Code</span><span class="val">$(username)</span></div>
<div class="row"><span class="lbl">MAC Address</span><span class="val">$(mac)</span></div>
<div class="row"><span class="lbl">IP Address</span><span class="val">$(ip)</span></div>
<div class="row"><span class="lbl">Bytes In/Out</span><span class="val">$(bytes-in-nice) / $(bytes-out-nice)</span></div>
</div>
<a href="$(link-logout)" class="btn btno">\u2716 Ondoka (Logout)</a>
<div class="ft">SHIMBA WiFi &bull; Furahia internet ya kasi!</div>
</div>
<script>
(function(){
var u="$(username)";var m="$(mac)";var i="$(ip)";
// Save voucher in cookie for auto-reconnect (MikroTik domain)
if(u&&u!==""&&u!==" "){
document.cookie="shimba_voucher="+encodeURIComponent(u)+";path=/;max-age=604800";
var x=new XMLHttpRequest();x.open('GET','https://shimbawifi.xyz/api/hotspot-callback?user='+encodeURIComponent(u)+'&mac='+encodeURIComponent(m)+'&ip='+encodeURIComponent(i),true);x.send()
}
// Auto-redirect to Google after 3 seconds
setTimeout(function(){window.location.href='https://google.com'},3000);
})();
</script>
</body></html>`,

  'alogin.html': `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SHIMBA WIFI — Redirect</title>
<meta http-equiv="refresh" content="0;url=https://shimba-wifi-hub.vercel.app/?mac=$(mac)&ip=$(ip)&link-status=$(link-status)">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(180deg,#070b14,#0b1220);color:#eaf2ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px;font-size:14px}
.sp{width:28px;height:28px;border:3px solid #1f2a44;border-top-color:#22d3ee;border-radius:50%;animation:spin .8s linear infinite;margin:12px auto}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body><div>
<p>Inaelekeza kwenye lango la huduma...</p>
<div class="sp"></div>
</div>
<script>
(function(){var u="$(username)";var m="$(mac)";var i="$(ip)";if(u&&u!==""&&u!==" "){
document.cookie="shimba_voucher="+encodeURIComponent(u)+";path=/;max-age=604800";
var x=new XMLHttpRequest();x.open('GET','https://shimbawifi.xyz/api/hotspot-callback?user='+encodeURIComponent(u)+'&mac='+encodeURIComponent(m)+'&ip='+encodeURIComponent(i),true);x.send()
}location.href="https://shimba-wifi-hub.vercel.app/?mac="+encodeURIComponent(m)+"&ip="+encodeURIComponent(i)+"&link-status=$(link-status)"})();
</script>
</body></html>`,

  'login.html': `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SHIMBA WIFI</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:linear-gradient(180deg,#070b14,#0b1220);color:#eaf2ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}
.c{max-width:400px;width:100%}
.l{font-size:48px;margin-bottom:8px}
h1{font-size:22px;font-weight:900;margin-bottom:4px;background:linear-gradient(135deg,#22d3ee,#93c5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.p{font-size:13px;color:#8aa0c4;margin-bottom:20px}
.inp{width:100%;padding:12px 16px;border-radius:12px;border:1px solid #1f2a44;background:#0a1426;color:#eaf2ff;font-size:15px;text-align:center;font-family:monospace;letter-spacing:3px;outline:none;margin-bottom:10px}
.inp:focus{border-color:#22d3ee}
.btn{width:100%;padding:14px;border-radius:14px;border:none;background:linear-gradient(135deg,#22d3ee,#3b82f6);color:#001018;font-size:15px;font-weight:800;cursor:pointer;margin-top:4px}
.btn:active{transform:translateY(1px)}
.err{color:#fca5a5;font-size:13px;margin-top:10px;background:rgba(239,68,68,0.1);padding:8px 12px;border-radius:8px;border:1px solid rgba(239,68,68,0.2)}
.ft{font-size:11px;color:#4a5f80;margin-top:20px}
a{color:#22d3ee;text-decoration:none}
</style></head>
<body>
$(if error == "")
<!-- No error — show form normally -->
$(else)
<div class="err">\u26A0 $(error)</div>
$(endif)
<div class="c">
<div class="l">\uD83D\uDCF6</div>
<h1>SHIMBA WIFI</h1>
<p class="p">Unganisha na SHIMBA WiFi</p>

<form method="post" action="$(link-login)" id="loginForm">
<input class="inp" name="username" id="username" type="text" placeholder="Voucher code" value="$(username)" autocomplete="off">
<input class="inp" name="password" id="password" type="password" placeholder="Password" value="$(password)">
<button class="btn" type="submit">\uD83D\uDEE1 Ingia kwenye WiFi</button>
</form>

<p class="p" style="margin-top:16px">Huna voucher? <a href="https://shimba-wifi-hub.vercel.app" target="_blank">Nunua hapa \u2197</a></p>
<div class="ft">SHIMBA WiFi</div>
</div>
<script>
(function(){
function getCookie(n){var m=document.cookie.match(new RegExp('(^| )'+n+'=([^;]+)'));return m?decodeURIComponent(m[2]):null}
var saved=getCookie('shimba_voucher');
if(saved&&!document.getElementById('username').value){
document.getElementById('username').value=saved;
document.getElementById('password').value=saved;
setTimeout(function(){document.getElementById('loginForm').submit()},100)
}
})();
</script>
</body>
</html>`,

};

/* ── Fix on-login callback URL (RSC script for MikroTik) ──
 *
 * Serves a .rsc script that fixes the on-login callback URL on all
 * hotspot user profiles. The ? character gets eaten by MikroTik terminal
 * (it's the help key), so this file is downloaded and imported instead.
 *
 * Usage on MikroTik:
 *   /tool fetch url="https://shimbawifi.xyz/api/fix-onlogin.rsc"
 *   /import fix-onlogin.rsc
 */
/* ── Capture a single active hotspot session (called by MikroTik hotspot-actives.rsc) ──
 *
 * MikroTik scheduler runs every 30 seconds, fetches /api/hotspot-actives.rsc,
 * and that RSC script loops through active sessions calling this endpoint.
 * No `?` in URL to avoid MikroTik help-key eating the query string.
 */
router.get('/api/capture-active/:user/:mac/:ip/:bytesIn?/:bytesOut?', (req: Request, res: Response) => {
  const user = String(req.params.user || '').trim().toUpperCase();
  const mac = String(req.params.mac || '').trim().toUpperCase();
  const ip = String(req.params.ip || '').trim();
  const bytesIn = parseInt(String(req.params.bytesIn || '0'), 10) || 0;
  const bytesOut = parseInt(String(req.params.bytesOut || '0'), 10) || 0;

  if (user) {
    const voucher = findVoucherByCode(user);
    upsertActiveUser(user, user, mac, ip, voucher?.package_name || null, bytesIn, bytesOut);
  }

  res.type('text/plain').send('ok');
});

/* ── Bulk report active sessions (POST, alternative to capture-active) ── */
router.post('/api/report-active-bulk', (req: Request, res: Response) => {
  const { sessions } = req.body || {};
  if (!Array.isArray(sessions)) {
    return res.json({ success: false, count: 0 });
  }
  const count = reportActiveSessions(sessions);
  logger.info('Hotspot', 'Bulk active session report', { count });
  res.json({ success: true, count });
});

/* ── Hotspot active reporter setup (RSC script for MikroTik) ──
 *
 * Download and import ONCE on MikroTik. This:
 *   1. Creates a scheduler (shimba-active) that runs every 30 seconds
 *   2. Fetches /api/hotspot-actives.rsc which reports active sessions
 *
 * Usage:
 *   /tool fetch url="https://shimbawifi.xyz/api/hotspot-active-report.rsc"
 *   /import hotspot-active-report.rsc
 */
router.get('/api/hotspot-active-report.rsc', (req: Request, res: Response) => {
  const baseUrl = config.publicBaseUrl;
  // CRITICAL: on-event must BOTH fetch AND import the RSC!
  // Fetch alone just downloads the file — it never executes.
  const schedulerEvent = `/tool fetch url="${baseUrl}/api/hotspot-actives.rsc"; :delay 3s; /import hotspot-actives.rsc`;
  const escapedEvent = escapeRsc(schedulerEvent);

  let script = `# SHIMBA WIFI — Hotspot Active Session Reporter
# Download and import ONCE on MikroTik:
#   /tool fetch url="${baseUrl}/api/hotspot-active-report.rsc"
#   /import hotspot-active-report.rsc
#
# This creates a scheduler that reports active hotspot sessions
# to the SHIMBA backend every 30 seconds.

:if ([/system scheduler find name="shimba-active"] = "") do={
  /system scheduler add name="shimba-active" interval=30s on-event="${escapedEvent}" start-time=startup
}

# Do initial sync right now (fetch + import = execute)
/tool fetch url="${baseUrl}/api/hotspot-actives.rsc"
:delay 3s
/import hotspot-actives.rsc
`;

  res.type('text/plain').send(script);
});

/* ── Report active hotspot sessions (RSC script for MikroTik scheduler) ──
 *
 * Called by the shimba-active scheduler every 30 seconds.
 * Iterates all active hotspot sessions and reports each one
 * to the backend via capture-active endpoint (no ? in URL).
 */
router.get('/api/hotspot-actives.rsc', (req: Request, res: Response) => {
  const baseUrl = config.publicBaseUrl;

  // IMPORTANT: $i, $u, $m, $a must NOT be escaped — they are MikroTik variables
  // that RouterOS expands at runtime. In JS template literals, $x is safe
  // (only ${...} interpolates), so bare $i, $u, etc. output as-is.
  let script = `# SHIMBA WIFI — Report active hotspot sessions
# Generated by backend — called by shimba-active scheduler

:foreach i in=[/ip hotspot active find] do={
  :local u [/ip hotspot active get $i user]
  :local m [/ip hotspot active get $i mac-address]
  :local a [/ip hotspot active get $i address]
  :local bi [/ip hotspot active get $i bytes-in]
  :local bo [/ip hotspot active get $i bytes-out]
  /tool fetch url="${baseUrl}/api/capture-active/$u/$m/$a/$bi/$bo" keep-result=no
}
`;

  res.type('text/plain').send(script);
});

router.get('/api/fix-onlogin.rsc', (req: Request, res: Response) => {
  const profiles = ['6hours-500', '24hours-1000', '48hours-2000', '7days-5000'];
  const callbackUrl = 'https://shimbawifi.xyz/api/hotspot-callback?user=$user&mac=$mac-address&ip=$address';

  let script = `# SHIMBA WIFI — Fix on-login callback URL
# Generated by backend — download and import on MikroTik:
#   /tool fetch url="https://shimbawifi.xyz/api/fix-onlogin.rsc"
#   /import fix-onlogin.rsc

`;

  for (const profile of profiles) {
    const escapedProfile = escapeRsc(profile);
    // Build the on-login value: we need proper RSC escaping
    // The value is: :global url "CALLBACK_URL"; /tool fetch url=$url
    const onLoginValue = `:global url "${callbackUrl}"; /tool fetch url=$url`;
    const escapedOnLogin = escapeRsc(onLoginValue);
    script += `/ip hotspot user profile set [find name="${escapedProfile}"] on-login="${escapedOnLogin}"
`;
  }

  res.type('text/plain').send(script);
});

router.get('/mt-files/:file', (req: Request, res: Response) => {
  const file = String(req.params.file || '');
  // Basic sanitize: only allow known hotspot files
  const basename = file.split('/').pop() || file;

  if (config.hotspotFiles.has(basename) && HOTSPOT_FILES[basename]) {
    res.type('text/html').send(HOTSPOT_FILES[basename]);
    return;
  }

  res.status(404).json({ success: false, message: 'Hotspot file not found' });
});

export default router;
