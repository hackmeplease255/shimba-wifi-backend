"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushVoucher = pushVoucher;
exports.healthCheck = healthCheck;
/**
 * MikroTik RouterOS API client.
 * Uses raw TCP (port 8728) with MD5-challenge auth.
 * Includes retry logic and proper error handling.
 *
 * Protocol flow:
 *   1. Send /login
 *   2. Receive challenge hash
 *   3. Send /login with name + MD5 response
 *   4. Receive login confirmation (done)
 *   5. Send the actual command
 *   6. Receive command response + done
 */
const net_1 = __importDefault(require("net"));
const crypto_1 = __importDefault(require("crypto"));
const config_1 = require("./config");
const utils_1 = require("./utils");
function mikrotikCommand(command, retries = config_1.config.mikrotik.retries) {
    return new Promise((resolve, reject) => {
        const { host, port, user, password, timeout } = config_1.config.mikrotik;
        if (!host || !user) {
            return reject(new Error('MikroTik not configured (MIKROTIK_IP or MIKROTIK_USER missing)'));
        }
        let buf = Buffer.alloc(0);
        let completed = false; // track if already resolved/rejected
        const sock = net_1.default.createConnection({ host, port }, () => {
            if (completed)
                return;
            sock.write('/login\n');
        });
        const timer = setTimeout(() => {
            if (completed)
                return;
            completed = true;
            try {
                sock.destroy();
            }
            catch { /* ignore */ }
            reject(new Error(`MikroTik connection timeout after ${timeout}ms`));
        }, timeout);
        // State machine: 'login' → 'respond' → 'command'
        let state = 'login';
        sock.on('data', (data) => {
            if (completed)
                return;
            buf = Buffer.concat([buf, data]);
            const str = buf.toString();
            // Check for error responses from MikroTik
            if (str.includes('!trap') || str.includes('!fatal')) {
                const errorMatch = str.match(/message=([^\n]+)/);
                const errMsg = errorMatch ? errorMatch[1].trim() : str.slice(0, 200);
                clearTimeout(timer);
                completed = true;
                sock.destroy();
                return reject(new Error(`MikroTik error: ${errMsg}`));
            }
            if (!str.includes('!done'))
                return; // Wait for full response
            if (state === 'login') {
                // First response: got challenge hash after /login
                const hashMatch = str.match(/=ret=([a-f0-9]+)/);
                if (!hashMatch) {
                    clearTimeout(timer);
                    completed = true;
                    sock.destroy();
                    return reject(new Error('No challenge hash from MikroTik'));
                }
                const hash = hashMatch[1];
                const response = crypto_1.default.createHash('md5').update('\x00' + password + hash).digest('hex');
                // Clear buffer and send login credentials
                buf = Buffer.alloc(0);
                sock.write(`/login\n=name=${user}\n=response=${response}\n`);
                state = 'respond';
            }
            else if (state === 'respond') {
                // Login confirmed — now send the actual command
                buf = Buffer.alloc(0);
                sock.write(command + '\n');
                state = 'command';
            }
            else if (state === 'command') {
                // Command response received — we're done
                clearTimeout(timer);
                completed = true;
                sock.destroy();
                resolve(str);
            }
        });
        sock.on('error', (err) => {
            if (completed)
                return;
            clearTimeout(timer);
            completed = true;
            reject(new Error(`MikroTik connection failed: ${err.message}`));
        });
        sock.on('close', () => {
            clearTimeout(timer);
            if (!completed) {
                completed = true;
                reject(new Error('MikroTik connection closed unexpectedly'));
            }
        });
    });
}
/** Run a MikroTik command with automatic retries */
async function mikrotikCommandWithRetry(command) {
    let lastError = null;
    for (let attempt = 1; attempt <= config_1.config.mikrotik.retries; attempt++) {
        try {
            return await mikrotikCommand(command);
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt < config_1.config.mikrotik.retries) {
                utils_1.logger.warn('MikroTik', `Attempt ${attempt}/${config_1.config.mikrotik.retries} failed, retrying...`, { error: lastError.message });
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }
    throw lastError || new Error('MikroTik command failed after all retries');
}
/** Check if an IP is private/local (not reachable from cloud hosting) */
function isPrivateIp(ip) {
    // Private ranges:
    //   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4)
        return false;
    if (parts[0] === 10)
        return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        return true;
    if (parts[0] === 192 && parts[1] === 168)
        return true;
    if (parts[0] === 127)
        return true;
    return false;
}
/** Push a single voucher to MikroTik as a hotspot user */
async function pushVoucher(voucher) {
    const { host } = config_1.config.mikrotik;
    // If MikroTik is on a private/local IP, the cloud can't reach it.
    // Skip the API call immediately (saves 30s timeout per attempt).
    // User must sync vouchers via the .rsc script instead.
    if (host && isPrivateIp(host)) {
        utils_1.logger.info('MikroTik', `Skipped API push (${host} is local network — cloud can't reach it). Use .rsc script to sync vouchers.`, { code: voucher.code });
        return false;
    }
    try {
        const code = (0, utils_1.escapeRsc)(voucher.code);
        const profile = (0, utils_1.escapeRsc)(voucher.mikrotik_profile);
        const limit = (0, utils_1.escapeRsc)(voucher.limit_uptime);
        const comment = (0, utils_1.escapeRsc)(`SHIMBA ${voucher.package_name} ${voucher.order_reference}`);
        // Add limit-uptime directly on the user so it overrides the profile's uptime-limit
        // This ensures the user gets the correct time even if the MikroTik profile is misconfigured.
        const cmd = `/ip hotspot user add name=${code} password=${code} profile=${profile} limit-uptime=${limit} comment=${comment}`;
        await mikrotikCommandWithRetry(cmd);
        utils_1.logger.info('MikroTik', 'Voucher pushed successfully', { code: voucher.code });
        return true;
    }
    catch (err) {
        utils_1.logger.error('MikroTik', 'Failed to push voucher (will sync via .rsc script later)', {
            code: voucher.code,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}
/** Check if MikroTik is reachable */
async function healthCheck() {
    const { host } = config_1.config.mikrotik;
    if (host && isPrivateIp(host)) {
        return { reachable: false, error: `${host} is a local IP — not reachable from cloud. Use .rsc script to sync.` };
    }
    try {
        await mikrotikCommand('/system resource print', 1);
        return { reachable: true };
    }
    catch (err) {
        return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
}
//# sourceMappingURL=mikrotik.js.map