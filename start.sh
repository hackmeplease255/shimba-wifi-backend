#!/bin/bash
# SHIMBA WiFi - Startup Script (v2.2)
# Inasimamia npm dependencies, TypeScript build, na server

echo "=== SHIMBA WiFi Starting (v2.2) ==="

# ── Install dependencies (if needed) ──────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "[Setup] Installing dependencies..."
  npm install
fi

# ── Build TypeScript ──────────────────────────────────────────────────────────
echo "[Build] Compiling TypeScript..."
npx -p typescript tsc
echo "[Build] Compilation complete"

# ── Start the Node.js server (compiled JS) ────────────────────────────────────
echo "[Start] Launching server..."
exec node dist/index.js
