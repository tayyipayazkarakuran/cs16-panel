#!/bin/bash
# =============================================================
#  CS 1.6 Panel — Full Deploy Script
#  Run on the server as root
# =============================================================
set -e

SERVER_IP="YOUR_SERVER_IP"
DEPLOY_DIR="/opt/cspanel"
DOMAIN_PANEL="panel.example.com"
DOMAIN_LANDING="example.com"
DOMAIN_FASTDL="fastdl.example.com"
DOMAIN_MYSQL="mysql.example.com"

echo "============================================="
echo " CS 1.6 Panel Deploy — $(date)"
echo "============================================="

# ---- 1. Install Docker & Docker Compose (if not present) ----
if ! command -v docker &>/dev/null; then
    echo "[1] Installing Docker..."
    curl -fsSL https://get.docker.com | bash
    systemctl enable --now docker
else
    echo "[1] Docker already installed: $(docker --version)"
fi

if ! docker compose version &>/dev/null; then
    echo "[1b] Installing Docker Compose plugin..."
    apt-get install -y docker-compose-plugin
fi

# ---- 2. Install Nginx & Certbot ----
if ! command -v nginx &>/dev/null; then
    echo "[2] Installing Nginx & Certbot..."
    apt-get update -y
    apt-get install -y nginx certbot python3-certbot-nginx
else
    echo "[2] Nginx already installed."
fi

# ---- 3. Create deploy directory ----
echo "[3] Setting up $DEPLOY_DIR..."
mkdir -p "$DEPLOY_DIR"

echo ""
echo "============================================="
echo " NEXT STEPS (run manually):"
echo "============================================="
echo ""
echo "1. Copy project files to server:"
echo "   scp -r /path/to/cspanel root@$SERVER_IP:$DEPLOY_DIR"
echo ""
echo "2. SSH to server and run:"
echo "   cd $DEPLOY_DIR && docker compose up -d --build"
echo ""
echo "3. Configure Nginx (see nginx setup below)"
echo ""
echo "4. Get SSL certificates:"
echo "   certbot --nginx -d $DOMAIN_PANEL -d $DOMAIN_LANDING -d $DOMAIN_FASTDL -d $DOMAIN_MYSQL"
echo ""
