/**
 * Authentication middleware.
 * Supports two methods:
 * 1. JWT Bearer token (preferred)
 * 2. Basic Auth (fallback for backward compatibility)
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils';

export interface AdminPayload {
  username: string;
  role: 'admin';
}

/** Generate a JWT token for admin */
export function generateAdminToken(username: string): string {
  const payload: AdminPayload = { username, role: 'admin' };
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn } as jwt.SignOptions);
}

/** Express middleware that requires admin authentication */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  // Try JWT Bearer token first
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, config.jwt.secret) as AdminPayload;
      (req as any).admin = decoded;
      return next();
    } catch (err) {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }
  }

  // Fallback to Basic Auth
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      const username = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);

      if (username === config.admin.username && password === config.admin.password) {
        (req as any).admin = { username, role: 'admin' as const };
        return next();
      }
    } catch {
      // Fall through to error
    }
    res.status(401).json({ success: false, message: 'Wrong username or password' });
    return;
  }

  res.status(401).json({ success: false, message: 'Unsupported auth method. Use Bearer token or Basic auth.' });
}

/** Generate a login token — POST /api/admin/login with Basic auth */
export function loginHandler(req: Request, res: Response): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.status(401).json({ success: false, message: 'Basic auth required' });
    return;
  }

  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);

    if (username === config.admin.username && password === config.admin.password) {
      const token = generateAdminToken(username);
      res.json({ success: true, token, expiresIn: config.jwt.expiresIn });
    } else {
      res.status(401).json({ success: false, message: 'Wrong credentials' });
    }
  } catch {
    res.status(401).json({ success: false, message: 'Invalid auth header' });
  }
}
