"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validatePayRequest = validatePayRequest;
exports.validateOrderRef = validateOrderRef;
const utils_1 = require("../utils");
const config_1 = require("../config");
/** Validate the /pay-mongike request body */
function validatePayRequest(req, res, next) {
    const { phone, package_name } = req.body || {};
    if (!phone || !package_name) {
        res.status(400).json({ success: false, message: 'Phone na package_name zinahitajika.' });
        return;
    }
    const normalized = (0, utils_1.normalizePhone)(phone);
    if (!(0, utils_1.isValidPhone)(normalized)) {
        res.status(400).json({
            success: false,
            message: 'Namba ya simu si sahihi. Tafadhali weka namba halali ya Tanzania (mfano 0712 345 678).',
        });
        return;
    }
    if (!(0, config_1.isValidPackage)(package_name)) {
        res.status(400).json({
            success: false,
            message: `Kifurushi "${package_name}" hakipo. Chagua kati ya: 6hours, 24hours, 48hours, 7days.`,
        });
        return;
    }
    const pkg = (0, config_1.getPackage)(package_name);
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
function validateOrderRef(req, res, next) {
    const ref = req.params.orderReference || req.body?.order_reference;
    if (!ref || typeof ref !== 'string' || ref.length < 4) {
        res.status(400).json({ success: false, message: 'Order reference haijakamilika.' });
        return;
    }
    next();
}
//# sourceMappingURL=validation.js.map