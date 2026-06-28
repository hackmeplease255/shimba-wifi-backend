# SHIMBA WIFI Backend (API only)

JSON API. No frontend hosting.

## Install
    npm install

## Configure
Edit `.env`:
- MONGIKE_API_KEY=
- MONGIKE_BASE_URL=https://mongike.com
- MONGIKE_PAYMENT_ENDPOINT=/api/v1/payments/mobile-money/tanzania
- PORT=22896
- PUBLIC_BASE_URL=https://your-backend-domain   # used for webhook URL

## Run
    npm start

## Endpoints
- GET  /            → status JSON
- GET  /health      → { success:true, status:'online' }
- GET  /packages    → package map
- POST /pay-mongike  body: { phone, package_name }   package_name ∈ 6hours|24hours|48hours|7days
- GET  /payment-status/:orderReference
- GET  /api/voucher-status/:code
- POST /api/mongike-webhook  (called by Mongike)

CORS is open (*) for all origins.
