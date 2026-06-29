"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../config");
const db_1 = require("../db");
const utils_1 = require("../utils");
const mikrotik_1 = require("../mikrotik");
const router = (0, express_1.Router)();
const COOKIE_SCRIPT = `(function(){var u="$(username)";var m="$(mac)";var i="$(ip)";if(u&&u!==""&&u!==" "){document.cookie="shimba_voucher="+encodeURIComponent(u)+";path=/;max-age=604800";var x=new XMLHttpRequest();x.open('GET','https://shimbawifi.xyz/api/hotspot-callback?user='+encodeURIComponent(u)+'&mac='+encodeURIComponent(m)+'&ip='+encodeURIComponent(i),true);x.send()}})();`
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
            // Record the login in active_users so the admin panel sees it
            const clientIp = req.ip || req.socket.remoteAddress || '';
            (0, db_1.upsertActiveUser)(voucher.code, voucher.code, mac, clientIp, voucher.package_name);
            utils_1.logger.info('Hotspot', 'Auto-connect found voucher for MAC', { mac, code: association.code, ip: clientIp });
            return res.json({
                auto: true,
                code: association.code,
                package_name: association.package_name,
            });
        }
    }
    res.json({ auto: false });
});

/* ── Associate a MAC address (GET — for alogin.html fallback) ── */
router.get('/api/associate-mac', (req, res) => {
    const mac = String(req.query.mac || '').trim().toUpperCase();
    const code = String(req.query.code || '').trim().toUpperCase();
    const ip = String(req.query.ip || '').trim();
    if (!mac || !code) {
        return res.json({ success: false });
    }
    const voucher = (0, db_1.findVoucherByCode)(code);
    if (!voucher) {
        return res.json({ success: false, message: 'Voucher not found' });
    }
    (0, db_1.saveMacAssociation)(mac, voucher.code, voucher.package_name);
    (0, db_1.upsertActiveUser)(voucher.code, voucher.code, mac, ip, voucher.package_name);
    utils_1.logger.info('Hotspot', 'MAC associated via GET (for alogin fallback)', { mac, code: voucher.code, ip });
    res.json({ success: true });
});

/* ── Associate a MAC address (POST — for portal) ── */
router.post('/api/associate-mac', (req, res) => {
    const { mac, code, ip } = req.body || {};
    if (!mac || !code) {
        return res.json({ success: false });
    }
    const voucher = (0, db_1.findVoucherByCode)(String(code).trim().toUpperCase());
    if (!voucher) {
        return res.json({ success: false });
    }
    const normalizedMac = String(mac).trim().toUpperCase();
    const clientIp = String(ip || '').trim();
    (0, db_1.saveMacAssociation)(normalizedMac, voucher.code, voucher.package_name);
    (0, db_1.upsertActiveUser)(voucher.code, voucher.code, normalizedMac, clientIp, voucher.package_name);
    utils_1.logger.info('Hotspot', 'MAC associated with voucher + user logged in', { mac: normalizedMac, code: voucher.code, ip: clientIp });
    res.json({ success: true });
});

/* ── Hotspot callback from status/alogin pages (no token needed) */
router.get('/api/hotspot-callback', (req, res) => {
    const user = String(req.query.user || '').trim().toUpperCase();
    let mac = String(req.query.mac || '').trim().toUpperCase();
    const ip = String(req.query.ip || '').trim();
    if (!user) {
        return res.status(400).send('missing user');
    }
    // If MAC is empty, try to find it from active_users records for this user
    if (!mac) {
        const rows = (0, db_1.queryAll)('SELECT mac FROM active_users WHERE user = ? AND mac IS NOT NULL AND mac != ? ORDER BY updated_at DESC LIMIT 1', [user, '']);
        if (rows.length > 0 && rows[0].mac && String(rows[0].mac).trim() !== '') {
            mac = String(rows[0].mac).toUpperCase();
        }
    }
    const voucher = (0, db_1.findVoucherByCode)(user);
    (0, db_1.upsertActiveUser)(user, user, mac, ip, voucher?.package_name || null);
    utils_1.logger.info('Hotspot', 'User logged in (callback from hotspot page)', { user, mac, ip });
    res.type('text/plain').send('ok');
});

/* ── Auto-login: prepare voucher for MikroTik + authenticate ── */
router.get('/api/auto-login', async (req, res) => {
    const code = String(req.query.code || '').trim().toUpperCase();
    const mac = String(req.query.mac || '').trim().toUpperCase();
    const ip = String(req.query.ip || '').trim();
    if (!code) {
        return res.json({ auto: false, reason: 'missing_code' });
    }
    // 1. Find the voucher
    const voucher = (0, db_1.findVoucherByCode)(code);
    if (!voucher) {
        return res.json({ auto: false, reason: 'not_found', message: 'Vocha haijapatikana' });
    }
    // 2. Check if expired
    if ((0, db_1.isVoucherExpired)(voucher)) {
        (0, db_1.markVoucherExpired)(code);
        return res.json({ auto: false, reason: 'expired', message: 'Vocha yako muda wake umekwisha' });
    }
    // 3. If voucher is not synced, try to push to MikroTik NOW
    let synced = !!voucher.synced;
    if (!synced) {
        try {
            const pushed = await (0, mikrotik_1.pushVoucher)({
                code, package_name: voucher.package_name,
                mikrotik_profile: voucher.mikrotik_profile, limit_uptime: voucher.limit_uptime,
                order_reference: voucher.order_reference,
            });
            if (pushed) {
                (0, db_1.markVoucherSynced)(code);
                synced = true;
                utils_1.logger.info('Hotspot', 'Auto-login: Voucher pushed to MikroTik', { code });
            }
        }
        catch (err) {
            utils_1.logger.warn('Hotspot', 'Auto-login: Failed to push voucher', { code, error: String(err) });
        }
    }
    // 4. Save MAC association (for future auto-reconnect lookups)
    if (mac) {
        (0, db_1.saveMacAssociation)(mac, code, voucher.package_name);
    }
    // 5. Record in active_users
    (0, db_1.upsertActiveUser)(code, code, mac, ip, voucher.package_name);
    utils_1.logger.info('Hotspot', 'Auto-login: User authenticated', { code, mac, ip, synced });
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

/* ── Serve MikroTik hotspot files ── */
const HOTSPOT_FILES = {
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
${COOKIE_SCRIPT}
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
${COOKIE_SCRIPT}
location.href="https://shimba-wifi-hub.vercel.app/?mac="+encodeURIComponent(m)+"&ip="+encodeURIComponent(i)+"&link-status=$(link-status)";
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
router.get('/mt-files/:file', (req, res) => {
    const file = String(req.params.file || '');
    // Basic sanitize: only allow known hotspot files
    const basename = file.split('/').pop() || file;
    if (config_1.config.hotspotFiles.has(basename) && HOTSPOT_FILES[basename]) {
        res.type('text/html').send(HOTSPOT_FILES[basename]);
        return;
    }
    res.status(404).json({ success: false, message: 'Hotspot file not found' });
});
exports.default = router;
//# sourceMappingURL=hotspot.js.map