#!/bin/bash
# =============================================================
#  CS 1.6 Panel — Server Setup Script
#  Run this on the server: bash /tmp/server_setup.sh
# =============================================================
set -e

DEPLOY_DIR="/opt/cspanel"
HOST_IP="YOUR_SERVER_IP"

echo "============================================="
echo " CS 1.6 Panel Server Setup"
echo " Date: $(date)"
echo "============================================="

# ---- 1. System update ----
echo ""
echo "[1/7] Updating system..."
apt-get update -y && apt-get upgrade -y -q

# ---- 2. Install Docker ----
echo ""
echo "[2/7] Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | bash
    systemctl enable --now docker
    echo "Docker installed: $(docker --version)"
else
    echo "Docker already installed: $(docker --version)"
fi

# Install Docker Compose plugin
if ! docker compose version &>/dev/null 2>&1; then
    apt-get install -y docker-compose-plugin
fi
echo "Docker Compose: $(docker compose version)"

# ---- 3. Install Nginx & Certbot ----
echo ""
echo "[3/7] Installing Nginx & Certbot..."
apt-get install -y nginx certbot python3-certbot-nginx

# ---- 4. Create deploy directory ----
echo ""
echo "[4/7] Creating deploy directory: $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

# ---- 5. Configure Nginx ----
echo ""
echo "[5/7] Configuring Nginx..."

cat > /etc/nginx/sites-available/cspanel.conf << 'NGINX_EOF'
# Landing Page
server {
    listen 80;
    server_name example.com www.example.com;

    if ($host = www.example.com) {
        return 301 https://example.com$request_uri;
    }

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}

# Panel SPA + WebSocket
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}

# FastDL
server {
    listen 80;
    server_name fastdl.example.com;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    on;
        proxy_buffer_size  128k;
        proxy_buffers      4 256k;
    }
}

# PHP wildcard: php-{port}.example.com
server {
    listen 80;
    server_name ~^php-(?<phpport>\d+)\.eskidostlar\.site$;

    location / {
        proxy_pass         http://127.0.0.1:8081/?p=$phpport;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

# MySQL proxy via port (direct TCP on 3306 handled by docker-compose binding)
# Note: MySQL is accessible at YOUR_SERVER_IP:3306 (bound only to localhost in docker-compose)
# For external access, change 127.0.0.1:3306 to 0.0.0.0:3306 in docker-compose.yml
NGINX_EOF

# Enable site
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/cspanel.conf /etc/nginx/sites-enabled/cspanel.conf

# Test Nginx config
nginx -t && systemctl reload nginx
echo "Nginx configured and running."

# ---- 6. Open firewall ports ----
echo ""
echo "[6/7] Configuring UFW firewall..."
if command -v ufw &>/dev/null; then
    ufw allow 22/tcp    comment 'SSH'
    ufw allow 80/tcp    comment 'HTTP'
    ufw allow 443/tcp   comment 'HTTPS'
    ufw allow 8080/tcp  comment 'FastDL Direct'
    ufw allow 8081/tcp  comment 'PHP Direct'
    ufw allow 3000/tcp  comment 'Panel Direct'
    ufw allow 27015:29000/udp comment 'CS Game Servers UDP'
    ufw allow 27015:29000/tcp comment 'CS Game Servers TCP'
    # MySQL accessible from game containers via docker network, expose to public only if needed
    # ufw allow 3306/tcp  comment 'MySQL (game server SQL cfg)'
    echo "y" | ufw enable || true
    ufw status verbose
fi

# ---- 7. Summary ----
echo ""
echo "============================================="
echo " Setup complete!"
echo "============================================="
echo ""
echo "NEXT STEPS:"
echo ""
echo "1. Upload project files:"
echo "   scp -r <local_path>/cspanel root@$HOST_IP:/opt/cspanel"
echo ""
echo "2. Create .env file (already done by the deploy script):"
echo "   cd /opt/cspanel && nano .env"
echo ""
echo "3. Start the stack:"
echo "   cd /opt/cspanel && docker compose up -d --build"
echo ""
echo "4. Get SSL certs (after DNS propagation):"
echo "   certbot --nginx \\"
echo "     -d example.com \\"
echo "     -d www.example.com \\"
echo "     -d panel.example.com \\"
echo "     -d fastdl.example.com"
echo ""
echo "5. Build CS 1.6 base image (first time only):"
echo "   cd /opt/cspanel && docker build -t cs16-server-base ."
echo ""
echo "Panel URL : http://panel.example.com  (after DNS)"
echo "Landing   : http://example.com"
echo "FastDL    : http://fastdl.example.com"
echo "Direct IP : http://$HOST_IP:3000"
