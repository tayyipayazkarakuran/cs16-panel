#!/usr/bin/env python3
"""
CS 1.6 Panel — Full Automated Deployment Script
Connects to the Hetzner server via SSH and deploys the full stack.
"""
import paramiko
import os
import sys
import time
import tarfile
import io

# ---- Config ----
HOST = "YOUR_SERVER_IP"
PORT = 22
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"
LOCAL_DIR = r"c:\Users\TayyipPC\Desktop\cspanel"
REMOTE_DIR = "/opt/cspanel"
ARCHIVE_NAME = "cspanel_deploy.tar.gz"

EXCLUDE_DIRS = {
    'node_modules', '.git', 'servers', 'uploads',
    'fastdl-data', 'php-www', '__pycache__', '.env.example'
}
EXCLUDE_EXTS = {'.tar.gz', '.log'}

def log(msg, color=""):
    colors = {"green": "\033[92m", "red": "\033[91m", "yellow": "\033[93m", "blue": "\033[94m", "": ""}
    reset = "\033[0m" if color else ""
    print(f"{colors.get(color,'')}{msg}{reset}", flush=True)

def make_tarball(local_dir, archive_path):
    log(f"\n[TAR] Creating archive from {local_dir}...", "blue")
    count = 0
    with tarfile.open(archive_path, "w:gz") as tar:
        for root, dirs, files in os.walk(local_dir):
            # Exclude dirs in-place
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
    log(f"    -> {count} files, {size_mb:.1f} MB", "green")
    return archive_path

def run_ssh_command(ssh, cmd, timeout=300, stream=True):
    log(f"\n$ {cmd}", "yellow")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    output = []
    while True:
        line = stdout.readline()
        if not line:
            break
        line = line.rstrip('\n')
        output.append(line)
        if stream:
            print(f"  {line}", flush=True)
    err = stderr.read().decode('utf-8', errors='replace').strip()
    if err and stream:
        for l in err.splitlines():
            print(f"  [STDERR] {l}", flush=True)
    exit_code = stdout.channel.recv_exit_status()
    return '\n'.join(output), exit_code

def upload_file(sftp, local_path, remote_path):
    log(f"[SCP] {os.path.basename(local_path)} -> {remote_path}", "blue")
    sftp.put(local_path, remote_path)
    size = os.path.getsize(local_path) / (1024*1024)
    log(f"    -> Uploaded {size:.1f} MB", "green")


def main():
    log("\n" + "="*60, "blue")
    log(" CS 1.6 Panel — Automated Deployment", "blue")
    log(f" Target: {USER}@{HOST}:{REMOTE_DIR}", "blue")
    log("="*60, "blue")

    # ---- Step 0: Create archive ----
    archive_path = os.path.join(LOCAL_DIR, ARCHIVE_NAME)
    make_tarball(LOCAL_DIR, archive_path)

    # ---- Step 1: Connect ----
    log(f"\n[SSH] Connecting to {HOST}...", "blue")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=30)
    log("    -> Connected!", "green")

    sftp = ssh.open_sftp()

    # ---- Step 2: Install Docker ----
    log("\n" + "="*50, "blue")
    log(" STEP 1: Install Docker", "blue")
    log("="*50, "blue")
    out, code = run_ssh_command(ssh, "docker --version 2>/dev/null || echo 'NOT_INSTALLED'", timeout=10)
    if 'NOT_INSTALLED' in out or 'not found' in out.lower():
        log("Installing Docker...", "yellow")
        run_ssh_command(ssh, "curl -fsSL https://get.docker.com | bash", timeout=300)
        run_ssh_command(ssh, "systemctl enable --now docker", timeout=30)
    else:
        log(f"Docker already installed: {out.strip()}", "green")

    # Check Docker Compose
    out, code = run_ssh_command(ssh, "docker compose version 2>/dev/null || echo 'NOT_INSTALLED'", timeout=10)
    if 'NOT_INSTALLED' in out:
        log("Installing Docker Compose plugin...", "yellow")
        run_ssh_command(ssh, "apt-get install -y docker-compose-plugin 2>&1 | tail -5", timeout=120)

    # ---- Step 3: Install Nginx & Certbot ----
    log("\n" + "="*50, "blue")
    log(" STEP 2: Install Nginx & Certbot", "blue")
    log("="*50, "blue")
    out, _ = run_ssh_command(ssh, "nginx -v 2>/dev/null || echo 'NOT_INSTALLED'", timeout=10)
    if 'NOT_INSTALLED' in out:
        run_ssh_command(ssh, "apt-get update -y -q && apt-get install -y nginx certbot python3-certbot-nginx 2>&1 | tail -10", timeout=180)
    else:
        log(f"Nginx already installed: {out.strip()}", "green")

    # ---- Step 4: Create deploy dir ----
    log("\n" + "="*50, "blue")
    log(f" STEP 3: Setup {REMOTE_DIR}", "blue")
    log("="*50, "blue")
    run_ssh_command(ssh, f"mkdir -p {REMOTE_DIR}", timeout=10)

    # ---- Step 5: Upload archive ----
    log("\n" + "="*50, "blue")
    log(" STEP 4: Upload project files", "blue")
    log("="*50, "blue")
    upload_file(sftp, archive_path, f"{REMOTE_DIR}/{ARCHIVE_NAME}")

    # ---- Step 6: Extract ----
    log("\n" + "="*50, "blue")
    log(" STEP 5: Extract archive", "blue")
    log("="*50, "blue")
    run_ssh_command(ssh, f"cd {REMOTE_DIR} && tar -xzf {ARCHIVE_NAME}", timeout=60)
    run_ssh_command(ssh, f"ls -la {REMOTE_DIR}", timeout=10)

    # ---- Step 7: Configure Nginx ----
    log("\n" + "="*50, "blue")
    log(" STEP 6: Configure Nginx", "blue")
    log("="*50, "blue")
    nginx_conf = r"""
server {
    listen 80;
    server_name example.com www.example.com;
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
"""
    # Write nginx config via sftp
    with sftp.open('/etc/nginx/sites-available/cspanel.conf', 'w') as f:
        f.write(nginx_conf)
    run_ssh_command(ssh, "rm -f /etc/nginx/sites-enabled/default", timeout=5)
    run_ssh_command(ssh, "ln -sf /etc/nginx/sites-available/cspanel.conf /etc/nginx/sites-enabled/cspanel.conf", timeout=5)
    out, code = run_ssh_command(ssh, "nginx -t 2>&1", timeout=10)
    if 'successful' in out or 'ok' in out.lower():
        run_ssh_command(ssh, "systemctl reload nginx", timeout=15)
        log("Nginx configured OK", "green")
    else:
        log(f"Nginx config warning: {out}", "yellow")

    # ---- Step 8: UFW ----
    log("\n" + "="*50, "blue")
    log(" STEP 7: Configure UFW Firewall", "blue")
    log("="*50, "blue")
    ufw_cmds = [
        "ufw allow 22/tcp",
        "ufw allow 80/tcp",
        "ufw allow 443/tcp",
        "ufw allow 8080/tcp",
        "ufw allow 8081/tcp",
        "ufw allow 3000/tcp",
        "ufw allow 27015:29000/udp",
        "ufw allow 27015:29000/tcp",
    ]
    for cmd in ufw_cmds:
        run_ssh_command(ssh, cmd, timeout=10, stream=False)
    run_ssh_command(ssh, "echo y | ufw enable 2>&1 || true", timeout=15)
    run_ssh_command(ssh, "ufw status", timeout=10)

    # ---- Step 9: Build CS 1.6 base image ----
    log("\n" + "="*50, "blue")
    log(" STEP 8: Build CS 1.6 Docker image (cs16-server-base)", "blue")
    log("  This takes ~10-15 min. Please wait...", "yellow")
    log("="*50, "blue")
    out, code = run_ssh_command(ssh, "docker images cs16-server-base --format '{{.ID}}' 2>/dev/null", timeout=15)
    if out.strip():
        log(f"cs16-server-base already exists (ID: {out.strip()}), skipping build.", "green")
    else:
        log("Building cs16-server-base image...", "yellow")
        run_ssh_command(ssh, f"cd {REMOTE_DIR} && docker build -t cs16-server-base . 2>&1", timeout=1200)

    # ---- Step 10: Start stack ----
    log("\n" + "="*50, "blue")
    log(" STEP 9: Start Docker Compose stack", "blue")
    log("="*50, "blue")
    run_ssh_command(ssh, f"cd {REMOTE_DIR} && docker compose down 2>&1 || true", timeout=30)
    run_ssh_command(ssh, f"cd {REMOTE_DIR} && docker compose up -d --build 2>&1", timeout=300)

    # ---- Step 11: Verify ----
    log("\n" + "="*50, "blue")
    log(" STEP 10: Verification", "blue")
    log("="*50, "blue")
    time.sleep(10)
    run_ssh_command(ssh, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'", timeout=15)
    out, code = run_ssh_command(ssh, "curl -s http://127.0.0.1:3000/api/servers/public 2>&1 | head -c 500", timeout=15)
    if '"servers"' in out:
        log("\n✅ Panel API is UP and responding!", "green")
    else:
        log(f"\n!!️  Panel API response: {out[:200]}", "yellow")

    sftp.close()
    ssh.close()

    log("\n" + "="*60, "green")
    log(" ✅ DEPLOYMENT COMPLETE!", "green")
    log("="*60, "green")
    log(f"\n  Direct access : http://{HOST}:3000", "green")
    log(f"  Landing page  : http://{HOST}:3000 (root domain)")
    log(f"  Panel         : http://panel.example.com (after DNS)")
    log(f"  FastDL        : http://{HOST}:8080")
    log(f"\n  Admin login   : admin / YOUR_SSH_PASSWORD!")
    log(f"  User login    : user / user123")
    log("\n  Next: Set DNS records and run certbot for HTTPS", "yellow")

if __name__ == '__main__':
    main()
