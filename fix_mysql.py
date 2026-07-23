#!/usr/bin/env python3
"""Fix MySQL root access and restart cs-panel"""
import paramiko
import time

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"
MYSQL_PASS = "cs_root_2024"

def run(ssh, cmd, timeout=60, show=True):
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout, get_pty=True)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    result = (out + err).strip()
    if show and result:
        print(result[:3000])
    return result

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30)
print(f"Connected to {HOST}")

# 1. Check MySQL status
print("\n=== MySQL container status ===")
run(ssh, "docker ps | grep mysql")

# 2. Check MySQL root users
print("\n=== Current MySQL root users ===")
run(ssh, f"docker exec cs-mysql mysql -uroot -p{MYSQL_PASS} -e \"SELECT user, host, plugin FROM mysql.user WHERE user='root';\" 2>&1")

# 3. Fix: Grant root@% with native password
print("\n=== Granting root@% access ===")
fix_sql = (
    "CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'cs_root_2024';"
    "ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'cs_root_2024';"
    "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;"
    "FLUSH PRIVILEGES;"
)
run(ssh, f"docker exec cs-mysql mysql -uroot -p{MYSQL_PASS} -e \"{fix_sql}\" 2>&1")

# 4. Verify fix
print("\n=== Verify fix ===")
run(ssh, f"docker exec cs-mysql mysql -uroot -p{MYSQL_PASS} -e \"SELECT user, host FROM mysql.user WHERE user='root';\" 2>&1")

# 5. Test connection from panel container network IP perspective
print("\n=== Testing connection from cs-panel network ===")
# Get cs-panel container's IP on cs-network
panel_ip_out = run(ssh, "docker inspect cs-panel --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' 2>/dev/null", show=False)
print(f"Panel IP: {panel_ip_out}")

# Test MySQL connection from the cs-panel container
run(ssh, f"docker run --rm --network cs-network mysql:8.0 mysql -hcs-mysql -uroot -p{MYSQL_PASS} -e 'SELECT 1;' 2>&1")

# 6. Restart cs-panel
print("\n=== Restarting cs-panel ===")
run(ssh, "docker restart cs-panel 2>&1")
time.sleep(8)

# 7. Check if panel is running now
print("\n=== Final status ===")
run(ssh, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'")

# 8. Check panel logs
print("\n=== cs-panel logs (last 30 lines) ===")
run(ssh, "docker logs cs-panel --tail 30 2>&1")

# 9. Test API
print("\n=== Testing API ===")
import time
time.sleep(5)
run(ssh, "curl -s http://127.0.0.1:3000/api/servers/public 2>&1 | head -c 300")

ssh.close()
print("\nDone!")
