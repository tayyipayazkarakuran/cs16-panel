#!/usr/bin/env python3
"""Fix Nginx conflicting server name warning"""
import paramiko

HOST = "YOUR_SERVER_IP"

def run(ssh, cmd, timeout=30, show=True):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    result = (out + err).strip()
    if show and result:
        print(result[:2000])
    return result

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username='root', password='YOUR_SSH_PASSWORD', timeout=30)

# Check what other nginx configs exist
print("=== Existing Nginx configs ===")
run(ssh, "ls -la /etc/nginx/sites-enabled/ && ls -la /etc/nginx/conf.d/ 2>/dev/null")

# Remove any conflicting configs
run(ssh, "rm -f /etc/nginx/sites-enabled/default")
run(ssh, "ls /etc/nginx/conf.d/*.conf 2>/dev/null && rm -f /etc/nginx/conf.d/*.conf || true")

# Test and reload
out = run(ssh, "nginx -t 2>&1")
if 'successful' in out:
    run(ssh, "systemctl reload nginx 2>&1")
    print("Nginx OK - no more warnings!")

# Final Nginx test
run(ssh, "nginx -t 2>&1")

# Quick browser test via curl
print("\n=== Testing Landing Page via HTTP ===")
run(ssh, "curl -sv http://127.0.0.1:80/ 2>&1 | head -c 500")

print("\n=== Testing Panel via Nginx proxy ===")
run(ssh, "curl -s -H 'Host: panel.example.com' http://127.0.0.1:80/api/servers/public 2>&1 | head -c 200")

ssh.close()
print("\nDone!")
