#!/usr/bin/env bash
# =============================================================================
#  NIFTY Dashboard — One-Time VPS Setup Script
#  Run this once on a fresh Ubuntu 22.04 / Debian VPS
#
#  Usage:
#    chmod +x scripts/setup-vps.sh
#    sudo bash scripts/setup-vps.sh
# =============================================================================
set -euo pipefail

APP_DIR="/opt/nifty"           # Where the app lives on the VPS
APP_USER="nifty"               # Dedicated system user (not root)
NODE_VERSION="20"              # LTS Node.js

echo "=============================================="
echo " NIFTY Dashboard — VPS Setup"
echo "=============================================="

# ── 1. System packages ────────────────────────────────────────────────────────
echo ""
echo "[1/7] Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
    curl wget git build-essential \
    python3 python3-pip python3-venv \
    nginx certbot python3-certbot-nginx \
    cron

# ── 2. Node.js via nvm ────────────────────────────────────────────────────────
echo ""
echo "[2/7] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
    apt-get install -y nodejs
fi
node --version
npm --version

# ── 3. Python dependencies ────────────────────────────────────────────────────
echo ""
echo "[3/7] Installing Python packages..."
pip3 install --break-system-packages pyotp playwright 2>/dev/null || \
pip3 install pyotp playwright
# Install Chromium browser for Playwright (headless browser for Upstox login)
python3 -m playwright install chromium --with-deps

# ── 4. App user + directory ───────────────────────────────────────────────────
echo ""
echo "[4/7] Setting up app user and directory..."
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /bin/bash --home "$APP_DIR" --create-home "$APP_USER"
    echo "  Created user: $APP_USER"
fi
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 5. npm dependencies + build ───────────────────────────────────────────────
echo ""
echo "[5/7] Building Next.js app..."
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --silent
sudo -u "$APP_USER" npm run build
mkdir -p "$APP_DIR/data/runtime"
mkdir -p "$APP_DIR/logs"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/data" "$APP_DIR/logs"

# ── 6. Systemd service (keeps app running, auto-restarts) ─────────────────────
echo ""
echo "[6/7] Creating systemd service..."
cat > /etc/systemd/system/nifty-dashboard.service << SERVICE_EOF
[Unit]
Description=NIFTY Smart Money Dashboard (Next.js)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env.local
ExecStart=/usr/bin/node ${APP_DIR}/.next/standalone/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=nifty-dashboard

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable nifty-dashboard
systemctl restart nifty-dashboard
echo "  Systemd service: nifty-dashboard (enabled + started)"

# ── 7. Cron jobs ──────────────────────────────────────────────────────────────
echo ""
echo "[7/7] Installing cron jobs..."

# Auto-login at 8:55am IST (= 3:25am UTC) Monday–Friday
# Re-runs at 9:05am IST (= 3:35am UTC) as a safety retry
CRON_JOBS="
# NIFTY Dashboard — Upstox auto-login
# 8:55am IST (3:25am UTC) weekdays — primary login
25 3 * * 1-5 cd ${APP_DIR} && python3 scripts/auto-login.py >> ${APP_DIR}/logs/auto-login.log 2>&1

# 9:05am IST (3:35am UTC) weekdays — retry if primary failed
35 3 * * 1-5 cd ${APP_DIR} && python3 scripts/auto-login.py >> ${APP_DIR}/logs/auto-login.log 2>&1

# Log rotation — keep last 500 lines in log file
0 4 * * * tail -n 500 ${APP_DIR}/logs/auto-login.log > ${APP_DIR}/logs/auto-login.log.tmp && mv ${APP_DIR}/logs/auto-login.log.tmp ${APP_DIR}/logs/auto-login.log
"

# Write cron for the nifty user
(crontab -u "$APP_USER" -l 2>/dev/null | grep -v "NIFTY Dashboard" || true; echo "$CRON_JOBS") \
    | crontab -u "$APP_USER" -

echo "  Cron jobs installed for user: $APP_USER"

# ── Nginx reverse proxy (optional — comment out if not needed) ────────────────
cat > /etc/nginx/sites-available/nifty-dashboard << NGINX_EOF
server {
    listen 80;
    server_name _;         # Replace _ with your domain name

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host \$host;
        proxy_set_header   X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX_EOF

ln -sf /etc/nginx/sites-available/nifty-dashboard /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "=============================================="
echo " Setup complete!"
echo ""
echo " Next steps:"
echo "   1. Copy your project files to ${APP_DIR}/"
echo "   2. Create ${APP_DIR}/.env.local (see scripts/.env.example)"
echo "   3. Test auto-login manually:"
echo "      sudo -u ${APP_USER} python3 ${APP_DIR}/scripts/auto-login.py"
echo "   4. (Optional) Add SSL:"
echo "      certbot --nginx -d yourdomain.com"
echo "   5. Check service status:"
echo "      systemctl status nifty-dashboard"
echo "      journalctl -u nifty-dashboard -f"
echo "=============================================="
