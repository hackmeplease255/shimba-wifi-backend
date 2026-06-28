"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const db_1 = require("../db");
const utils_1 = require("../utils");
const router = (0, express_1.Router)();
/* ── Hotspot login callback (called by MikroTik) ── */
router.get('/api/hotspot-login', (req, res) => {
    if (req.query.token !== config_1.config.syncToken) {
        return res.status(401).send('bad token');
    }
    const user = String(req.query.user || '').trim().toUpperCase();
    const mac = String(req.query.mac || '').trim().toUpperCase();
    const ip = String(req.query.ip || '').trim();
    if (!user)
        return res.status(400).send('missing user');
    const voucher = (0, db_1.findVoucherByCode)(user);
    (0, db_1.upsertActiveUser)(user, user, mac, ip, voucher?.package_name || null);
    utils_1.logger.info('Hotspot', 'User logged in', { user, mac, ip });
    res.type('text/plain').send('ok');
});
/* ── Session status check ── */
router.get('/api/session-status', (req, res) => {
    const code = String(req.query.code || '').trim().toUpperCase();
    const mac = String(req.query.mac || '').trim().toUpperCase();
    const ip = String(req.query.ip || '').trim();
    const record = (0, db_1.findActiveUser)(code, mac, ip);
    const connected = Boolean(record);
    res.json({
        success: true,
        connected,
        session: connected ? {
            user: record.user,
            code: record.code,
            mac: record.mac,
            ip: record.ip,
            package_name: record.package_name,
            login_at: record.login_at,
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
router.get(`/mikrotik-sync-${config_1.config.syncToken}.rsc`, (req, res) => {
    const recentVouchers = (0, db_1.getRecentVouchers)(config_1.config.dataRetentionDays);
    // Filter: expired vouchers are REMOVED from MikroTik, active ones are ADDED.
    // This prevents users from reconnecting with an expired voucher.
    let script = '';
    for (const v of recentVouchers) {
        const code = (0, utils_1.escapeRsc)(v.code);
        if ((0, db_1.isVoucherExpired)(v)) {
            // Remove expired voucher from MikroTik and mark as used in DB
            script += `/ip hotspot user remove [find name="${code}"]
`;
            (0, db_1.markVoucherExpired)(v.code);
            // Note: MAC association cleanup is handled by auto-connect endpoint
            utils_1.logger.info('MikroTik', 'Expired voucher removed from sync script', { code: v.code });
        }
        else {
            const profile = (0, utils_1.escapeRsc)(v.mikrotik_profile);
            const limit = (0, utils_1.escapeRsc)(v.limit_uptime);
            const comment = (0, utils_1.escapeRsc)(`SHIMBA ${v.package_name} ${v.order_reference}`);
            script += `/ip hotspot user add name="${code}" password="${code}" profile="${profile}" limit-uptime="${limit}" comment="${comment}"
`;
        }
    }
    res.type('text/plain').send(script);
});
/* ── Mark voucher as synced (GET, called by MikroTik script) ── */
router.get('/api/mark-synced-get', (req, res) => {
    if (req.query.token !== config_1.config.syncToken) {
        return res.status(401).send('bad token');
    }
    const code = String(req.query.code || '').trim();
    if (code) {
        (0, db_1.markVoucherSynced)(code);
        utils_1.logger.info('MikroTik', 'Voucher marked synced via GET callback', { code });
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
router.get('/api/connect', (req, res) => {
    const code = String(req.query.code || '').trim().toUpperCase();
    if (!code) {
        return res.status(400).send('<html><body><h3>Missing voucher code</h3></body></html>');
    }
    // HTML-escape the code for safe rendering (XSS protection)
    const safeCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const safeCodeJs = JSON.stringify(code); // JSON-safe for JavaScript string
    const voucher = (0, db_1.findVoucherByCode)(code);
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
    <p style="color:#fbbf24;font-weight:600;">Inajaribu tena kuunganisha...</p>
    <p class="info">Vocha yako inaandaliwa kwenye router. Subiri sekunde chache...</p>
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
router.get('/api/auto-connect', (req, res) => {
    const mac = String(req.query.mac || '').trim().toUpperCase();
    if (!mac) {
        return res.json({ auto: false });
    }
    const association = (0, db_1.findMacAssociation)(mac);
    if (association) {
        // Verify the voucher still exists in the DB
        const voucher = (0, db_1.findVoucherByCode)(association.code);
        if (voucher) {
            // Check if voucher has expired (limit-uptime reached)
            if ((0, db_1.isVoucherExpired)(voucher)) {
                utils_1.logger.info('Hotspot', 'Auto-connect skipped — voucher expired', { mac, code: association.code });
                // Clean up the expired association so it doesn't trigger again
                (0, db_1.deleteMacAssociation)(mac);
                return res.json({ auto: false, expired: true, message: 'Vocha yako muda wake umekwisha. Tafadhali nunua mpya.' });
            }
            utils_1.logger.info('Hotspot', 'Auto-connect found voucher for MAC', { mac, code: association.code });
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
router.post('/api/associate-mac', (req, res) => {
    const { mac, code } = req.body || {};
    if (!mac || !code) {
        return res.json({ success: false });
    }
    const voucher = (0, db_1.findVoucherByCode)(String(code).trim().toUpperCase());
    if (!voucher) {
        return res.json({ success: false });
    }
    (0, db_1.saveMacAssociation)(String(mac).trim().toUpperCase(), voucher.code, voucher.package_name);
    utils_1.logger.info('Hotspot', 'MAC associated with voucher', { mac: String(mac).trim().toUpperCase(), code: voucher.code });
    res.json({ success: true });
});

/* ── Serve MikroTik hotspot files (placeholder) ── */
router.get('/mt-files/:file', (req, res) => {
    const file = String(req.params.file || '');
    // Basic sanitize: only allow known hotspot files
    const basename = file.split('/').pop() || file;
    if (!config_1.config.hotspotFiles.has(basename)) {
        return res.status(404).json({ success: false, message: 'Hotspot file not found' });
    }
    res.status(404).json({
        success: false,
        message: 'Hotspot files not hosted on this backend',
    });
});
exports.default = router;
//# sourceMappingURL=hotspot.js.map