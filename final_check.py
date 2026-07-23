#!/usr/bin/env python3
"""Build CS 1.6 base image and do final checks"""
import paramiko
import time

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"

def run(ssh, cmd, timeout=1200, show=True):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    result = (out + err).strip()
    if show and result:
        print(result[:5000])
    return result

print("Connecting...")
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30)
print("Connected!\n")

# 1. Check if cs16-server-base already exists
print("=== Checking CS 1.6 base image ===")
out = run(ssh, "docker images cs16-server-base --format '{{.ID}} {{.Size}}' 2>/dev/null", timeout=15)
if out.strip():
    print(f"cs16-server-base already exists: {out}")
else:
    print("Building cs16-server-base image (this takes ~10-15 min)...")
    print("Note: SteamCMD download of HLDS is the longest step.\n")
    run(ssh, "cd /opt/cspanel && docker build -t cs16-server-base . 2>&1", timeout=1200)
    print("\nBuild complete!")

# 2. Verify login credentials work
print("\n=== Testing admin login ===")
run(ssh, """curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR_SSH_PASSWORD!"}' 2>&1 | head -c 400""", timeout=15)

print("\n=== Testing user login ===")
run(ssh, """curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"user","password":"user123"}' 2>&1 | head -c 300""", timeout=15)

# 3. Final full status
print("\n=== FINAL STATUS ===")
run(ssh, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'", timeout=15)

print("\n=== Docker images ===")
run(ssh, "docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'", timeout=15)

print("\n=== Disk usage ===")
run(ssh, "df -h / && du -sh /opt/cspanel", timeout=15)

print("\n=== UFW Status ===")
run(ssh, "ufw status 2>/dev/null || echo 'UFW not active'", timeout=10)

print("\n=== Nginx status ===")
run(ssh, "nginx -t 2>&1 && systemctl is-active nginx", timeout=10)

ssh.close()

print("\n" + "="*60)
print("DEPLOYMENT SUMMARY")
print("="*60)
print(f"  Panel (direct): http://{HOST}:3000")
print(f"  Landing page  : http://{HOST}:3000")
print(f"  FastDL        : http://{HOST}:8080")
print(f"  PHP           : http://{HOST}:8081")
print(f"")
print(f"  Admin login : admin / YOUR_SSH_PASSWORD!")
print(f"  User login  : user / user123")
print(f"")
print(f"  Panel domain  : http://panel.example.com (DNS gerekli)")
print(f"  Landing domain: http://example.com (DNS gerekli)")
print("="*60)
print("\nSSL icin DNS kayitlarini ayarlayip certbot calistirin:")
print("  certbot --nginx -d example.com -d panel.example.com -d fastdl.example.com")
