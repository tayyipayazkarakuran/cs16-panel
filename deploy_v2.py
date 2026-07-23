import paramiko
import os
import tarfile
import time

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"
LOCAL_DIR = r"c:\Users\TayyipPC\Desktop\cspanel"
REMOTE_DIR = "/opt/cspanel"
ARCHIVE_NAME = "cspanel_v2.tar.gz"

EXCLUDE_DIRS = {
    'node_modules', '.git', 'servers', 'uploads',
    'fastdl-data', 'php-www', '__pycache__', '.env.example'
}
EXCLUDE_EXTS = {'.tar.gz', '.log'}

def log(msg, color=""):
    print(msg, flush=True)

def make_tarball(local_dir, archive_path):
    log(f"Creating archive from {local_dir}...")
    count = 0
    with tarfile.open(archive_path, "w:gz") as tar:
        for root, dirs, files in os.walk(local_dir):
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith('.')]
            rel_root = os.path.relpath(root, local_dir)
            for fname in files:
                if any(fname.endswith(e) for e in EXCLUDE_EXTS):
                    continue
                fpath = os.path.join(root, fname)
                arcname = os.path.join(rel_root, fname).replace('\\', '/')
                tar.add(fpath, arcname=arcname)
                count += 1
    size_mb = os.path.getsize(archive_path) / (1024*1024)
    log(f"  -> Packed {count} files, size: {size_mb:.2f} MB")
    return archive_path

def run_ssh(ssh, cmd):
    log(f"$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=300, get_pty=True)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    res = (out + err).strip()
    if res:
        print(f"  {res}")
    return res

def main():
    archive_path = os.path.join(LOCAL_DIR, ARCHIVE_NAME)
    make_tarball(LOCAL_DIR, archive_path)
    
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    log(f"Connecting to {HOST}...")
    ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30)
    log("Connected!")
    
    sftp = ssh.open_sftp()
    
    # Upload archive
    remote_archive = f"{REMOTE_DIR}/{ARCHIVE_NAME}"
    log(f"Uploading {ARCHIVE_NAME} to {remote_archive}...")
    sftp.put(archive_path, remote_archive)
    
    # Stop compose, extract and restart compose
    log("Stopping current stack...")
    run_ssh(ssh, f"cd {REMOTE_DIR} && docker compose down")
    
    log("Extracting new archive...")
    run_ssh(ssh, f"cd {REMOTE_DIR} && tar -xzf {ARCHIVE_NAME}")

    log("Updating existing servers' server.cfg files...")
    update_cfgs_cmd = "python3 -c \"\nimport glob, os\ncvars = '''\nsys_ticrate 1000\nfps_max 1000\nsv_minrate 25000\nsv_maxrate 100000\nsv_minupdaterate 20\nsv_maxupdaterate 102\nsv_unlag 1\nsv_maxunlag 0.5\nsv_unlagsamples 1\nsv_unlagpush 0\nsv_timeout 60\nsv_rehlds_movecmdrate_max_avg 2000\nsv_rehlds_movecmdrate_max_burst 5000\nsv_rehlds_movecmdrate_avg_punish -1\nsv_rehlds_movecmdrate_burst_punish -1\nsv_rehlds_local_gametime 1\n'''\nfor fp in glob.glob('/opt/cspanel/servers/*/cstrike/server.cfg'):\n    if not os.path.exists(fp): continue\n    with open(fp, 'r') as f: content = f.read()\n    lines = [line.strip() for line in content.splitlines()]\n    keys = [c.split()[0] for c in cvars.strip().splitlines()]\n    new_lines = [line for line in lines if line and not any(line.startswith(k) for k in keys)]\n    new_lines.append(cvars.strip())\n    with open(fp, 'w') as f: f.write('\\\\n'.join(new_lines) + '\\\\n')\n    print('Updated', fp)\n\""
    run_ssh(ssh, update_cfgs_cmd)

    log("Building game server base image (cs16-server)...")
    run_ssh(ssh, f"cd {REMOTE_DIR} && docker build -t cs16-server -f Dockerfile .")
    
    # Update Nginx conf
    log("Updating Nginx configuration...")
    nginx_conf = r"""
# =============================================================
#  Nginx Configuration for CS 1.6 Panel (HTTPS Enabled)
# =============================================================

# Set global/server upload limit to 100M
client_max_body_size 100M;

# ---- HTTP to HTTPS redirects ----
server {
    listen 80;
    server_name example.com www.example.com;
    client_max_body_size 100M;
    
    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        return 301 https://example.com$request_uri;
    }
}

server {
    listen 80;
    server_name panel.example.com;
    client_max_body_size 100M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        return 301 https://panel.example.com$request_uri;
    }
}

# ---- FastDL HTTP (essential for CS 1.6 client downloads) ----
server {
    listen 80;
    server_name fastdl.example.com;
    client_max_body_size 100M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_buffering    on;
        proxy_buffer_size  128k;
        proxy_buffers      4 256k;
    }
}

# ---- PHP wildcard subdomains HTTP (wildcard SSL not supported via HTTP challenge) ----
server {
    listen 80;
    server_name ~^php-(?<phpport>\d+)\.eskidostlar\.site$;
    client_max_body_size 100M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }

    location / {
        proxy_pass         http://127.0.0.1:8081/?p=$phpport;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

# ==================== HTTPS (Port 443) Server Blocks ====================

# ---- Landing Page HTTPS ----
server {
    listen 443 ssl;
    server_name example.com;
    client_max_body_size 100M;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

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

# ---- Panel SPA HTTPS ----
server {
    listen 443 ssl;
    server_name panel.example.com;
    client_max_body_size 100M;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

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

# ---- FastDL HTTPS ----
server {
    listen 443 ssl;
    server_name fastdl.example.com;
    client_max_body_size 100M;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_buffering    on;
        proxy_buffer_size  128k;
        proxy_buffers      4 256k;
    }
}
"""
    with sftp.open('/etc/nginx/sites-available/cspanel.conf', 'w') as f:
        f.write(nginx_conf)
        
    run_ssh(ssh, "rm -f /etc/nginx/sites-enabled/default")
    run_ssh(ssh, "ln -sf /etc/nginx/sites-available/cspanel.conf /etc/nginx/sites-enabled/cspanel.conf")
    run_ssh(ssh, "nginx -t && systemctl reload nginx")
    
    log("Building/Starting docker containers...")
    run_ssh(ssh, f"cd {REMOTE_DIR} && docker compose up -d --build")
    
    # Wait for panel to start and print status
    time.sleep(10)
    log("\nFinal Container Status:")
    run_ssh(ssh, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'")
    
    sftp.close()
    ssh.close()
    log("\nDeployment completed successfully!")

if __name__ == "__main__":
    main()
