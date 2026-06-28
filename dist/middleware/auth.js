"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAdminToken = generateAdminToken;
exports.adminAuth = adminAuth;
exports.loginHandler = loginHandler;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("../config");
/** Generate a JWT token for admin */
function generateAdminToken(username) {
    const payload = { username, role: 'admin' };
    return jsonwebtoken_1.default.sign(payload, config_1.config.jwt.secret, { expiresIn: config_1.config.jwt.expiresIn });
}
/** Express middleware that requires admin authentication */
function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
    }
    // Try JWT Bearer token first
    if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        try {
            const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwt.secret);
            req.admin = decoded;
            return next();
        }
        catch (err) {
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
            if (username === config_1.config.admin.username && password === config_1.config.admin.password) {
                req.admin = { username, role: 'admin' };
                return next();
            }
        }
        catch {
            // Fall through to error
        }
        res.status(401).json({ success: false, message: 'Wrong username or password' });
        return;
    }
    res.status(401).json({ success: false, message: 'Unsupported auth method. Use Bearer token or Basic auth.' });
}
/** Generate a login token — POST /api/admin/login with Basic auth */
function loginHandler(req, res) {
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
        if (username === config_1.config.admin.username && password === config_1.config.admin.password) {
            const token = generateAdminToken(username);
            res.json({ success: true, token, expiresIn: config_1.config.jwt.expiresIn });
        }
        else {
            res.status(401).json({ success: false, message: 'Wrong credentials' });
        }
    }
    catch {
        res.status(401).json({ success: false, message: 'Invalid auth header' });
    }
}
//# sourceMappingURL=auth.js.map