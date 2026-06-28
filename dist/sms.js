"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVoucherSms = sendVoucherSms;
/**
 * SMS provider for SHIMBA WiFi.
 * Designed to be optional — if SMS_ENABLED is not 'true', all calls are no-ops.
 * The user currently has no SMS provider; vouchers are delivered via the website.
 */
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
const utils_1 = require("./utils");
async function sendVoucherSms(phone, code, packageName) {
    if (!config_1.config.sms.enabled) {
        utils_1.logger.info('SMS', 'Skipped (SMS_ENABLED is false)');
        return { sent: false, provider: 'disabled', response: 'SMS_ENABLED is false' };
    }
    const message = `SHIMBA WiFi: Umenunua ${packageName}. Vocha yako ni: ${code}. Ingiza code hii kwenye portal ya WiFi kuanza kutumia internet. Asante!`;
    if (!config_1.config.sms.apiUrl) {
        utils_1.logger.warn('SMS', 'Missing SMS_API_URL');
        return { sent: false, provider: 'generic', response: 'Missing SMS_API_URL' };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (config_1.config.sms.authHeader)
        headers['Authorization'] = config_1.config.sms.authHeader;
    if (config_1.config.sms.bearerToken)
        headers['Authorization'] = `Bearer ${config_1.config.sms.bearerToken}`;
    if (config_1.config.sms.apiKey)
        headers['x-api-key'] = config_1.config.sms.apiKey;
    const normalizedPhone = (0, utils_1.normalizePhone)(phone);
    utils_1.logger.info('SMS', `Sending to ${normalizedPhone} via ${config_1.config.sms.apiUrl}`);
    try {
        const r = await axios_1.default.post(config_1.config.sms.apiUrl, {
            to: normalizedPhone,
            phone: normalizedPhone,
            message,
            sender: config_1.config.sms.sender,
            source_addr: config_1.config.sms.sender,
            recipients: [{ recipient_id: 1, dest_addr: normalizedPhone }],
            encoding: '0',
            schedule_time: '',
        }, { headers, timeout: 20000 });
        utils_1.logger.info('SMS', 'Sent successfully', { response: r.data });
        return { sent: true, provider: 'generic', response: JSON.stringify(r.data) };
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const responseData = err?.response?.data;
        utils_1.logger.error('SMS', 'Failed to send', { error: errorMsg, response: responseData });
        return { sent: false, provider: 'generic', response: responseData ? JSON.stringify(responseData) : errorMsg };
    }
}
//# sourceMappingURL=sms.js.map