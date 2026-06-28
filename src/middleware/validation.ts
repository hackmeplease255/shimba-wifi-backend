/**
 * Input validation middleware.
 * Validates phone numbers, package names, and order references.
 */
import { Request, Response, NextFunction } from 'express';
import { isValidPhone, normalizePhone } from '../utils';
import { isValidPackage, getPackage } from '../config';

/** Validate the /pay-mongike request body */
export function validatePayRequest(req: Request, res: Response, next: NextFunction): void {
  const { phone, package_name } = req.body || {};

  if (!phone || !package_name) {
    res.status(400).json({ success: false, message: 'Phone na package_name zinahitajika.' });
    return;
  }

  const normalized = normalizePhone(phone);
  if (!isValidPhone(normalized)) {
    res.status(400).json({
      success: false,
      message: 'Namba ya simu si sahihi. Tafadhali weka namba halali ya Tanzania (mfano 0712 345 678).',
    });
    return;
  }

  if (!isValidPackage(package_name)) {
    res.status(400).json({
      success: false,
      message: `Kifurushi "${package_name}" hakipo. Chagua kati ya: 6hours, 24hours, 48hours, 7days.`,
    });
    return;
  }

  const pkg = getPackage(package_name);
  if (!pkg) {
    res.status(400).json({ success: false, message: 'Kifurushi hakipo.' });
    return;
  }

  // Attach validated & normalized values
  req.body.phone = normalized;
  req.body.package_name = package_name;
  req.body.amount = pkg.amount;
  next();
}

/** Validate order reference parameter */
export function validateOrderRef(req: Request, res: Response, next: NextFunction): void {
  const ref = req.params.orderReference || req.body?.order_reference;
  if (!ref || typeof ref !== 'string' || ref.length < 4) {
    res.status(400).json({ success: false, message: 'Order reference haijakamilika.' });
    return;
  }
  next();
}
