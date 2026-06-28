/**
 * SMS provider for SHIMBA WiFi.
 * Designed to be optional — if SMS_ENABLED is not 'true', all calls are no-ops.
 * The user currently has no SMS provider; vouchers are delivered via the website.
 */
import axios from 'axios';
import { config } from './config';
import { normalizePhone, logger } from './utils';

export interface SmsResult {
  sent: boolean;
  provider: string;
  response: string;
}

export async function sendVoucherSms(phone: string, code: string, packageName: string): Promise<SmsResult> {
  if (!config.sms.enabled) {
    logger.info('SMS', 'Skipped (SMS_ENABLED is false)');
    return { sent: false, provider: 'disabled', response: 'SMS_ENABLED is false' };
  }

  const message = `SHIMBA WiFi: Umenunua ${packageName}. Vocha yako ni: ${code}. Ingiza code hii kwenye portal ya WiFi kuanza kutumia internet. Asante!`;

  if (!config.sms.apiUrl) {
    logger.warn('SMS', 'Missing SMS_API_URL');
    return { sent: false, provider: 'generic', response: 'Missing SMS_API_URL' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.sms.authHeader) headers['Authorization'] = config.sms.authHeader;
  if (config.sms.bearerToken) headers['Authorization'] = `Bearer ${config.sms.bearerToken}`;
  if (config.sms.apiKey) headers['x-api-key'] = config.sms.apiKey;

  const normalizedPhone = normalizePhone(phone);
  logger.info('SMS', `Sending to ${normalizedPhone} via ${config.sms.apiUrl}`);

  try {
    const r = await axios.post(config.sms.apiUrl, {
      to: normalizedPhone,
      phone: normalizedPhone,
      message,
      sender: config.sms.sender,
      source_addr: config.sms.sender,
      recipients: [{ recipient_id: 1, dest_addr: normalizedPhone }],
      encoding: '0',
      schedule_time: '',
    }, { headers, timeout: 20000 });

    logger.info('SMS', 'Sent successfully', { response: r.data });
    return { sent: true, provider: 'generic', response: JSON.stringify(r.data) };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const responseData = (err as any)?.response?.data;
    logger.error('SMS', 'Failed to send', { error: errorMsg, response: responseData });
    return { sent: false, provider: 'generic', response: responseData ? JSON.stringify(responseData) : errorMsg };
  }
}
