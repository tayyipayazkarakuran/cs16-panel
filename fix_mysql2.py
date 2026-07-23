#!/usr/bin/env python3
"""Reset MySQL volume and fix cs-panel startup"""
import paramiko
import time

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"

def run(ssh, cmd, timeout=120, show=True):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    result = (out + err).strip()
    if show and result:
        print(result[:3000])
    return result

print("Connecting to server...")
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30)
print("Connected!\n")

# Step 1: Try connecting with empty password first
print("=== Trying empty password ===")
out = run(ssh, "docker exec cs-mysql mysql -uroot --password='' -e 'SELECT 1;' 2>&1", show=True)

# Step 2: Try with no password flag at all
print("\n=== Trying no password ===")
out = run(ssh, "docker exec cs-mysql mysql -uroot -e 'SELECT 1;' 2>&1", show=True)

# Step 3: Check if there's an alternative root socket authentication
print("\n=== Checking MySQL users via auth_socket ===")
run(ssh, "docker exec cs-mysql bash -c \"mysql -uroot -e 'SELECT user,host,plugin FROM mysql.user;' 2>&1 || echo 'Failed'\"")

# Step 4: Nuclear option - wipe MySQL volume and restart fresh
print("\n=== NUCLEAR FIX: Wipe MySQL volume and restart fresh ===")
print("Stopping cs-panel and cs-mysql...")
run(ssh, "docker stop cs-panel cs-mysql 2>&1")
time.sleep(3)

print("\nRemoving MySQL data volume...")
run(ssh, "docker volume rm cs-mysql-data 2>&1 || true")

print("\nRestarting full stack...")
run(ssh, "cd /opt/cspanel && docker compose up -d 2>&1", timeout=120)

# Wait for MySQL to initialize (first start takes ~30s)
print("\nWaiting 40s for MySQL to initialize...")
time.sleep(40)

# Step 5: Verify MySQL is up with correct password
print("\n=== Verifying MySQL ===")
run(ssh, "docker exec cs-mysql mysql -uroot -pcs_root_2024 -e 'SELECT user,host FROM mysql.user WHERE user=\"root\";' 2>&1")

# Step 6: Explicitly grant root@% 
print("\n=== Granting root@% ===")
fix_sql = "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION; FLUSH PRIVILEGES;"
run(ssh, f"docker exec cs-mysql mysql -uroot -pcs_root_2024 -e \"{fix_sql}\" 2>&1")

# Step 7: Wait for cs-panel to start
print("\nWaiting 15s for cs-panel to start...")
time.sleep(15)

# Step 8: Final status
print("\n=== Final container status ===")
run(ssh, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'")

print("\n=== cs-panel logs ===")
run(ssh, "docker logs cs-panel --tail 25 2>&1")

print("\n=== API test ===")
run(ssh, "curl -s http://127.0.0.1:3000/api/servers/public 2>&1 | head -c 500")

ssh.close()
print("\nDone!")
