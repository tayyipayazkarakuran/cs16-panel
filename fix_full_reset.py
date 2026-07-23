#!/usr/bin/env python3
"""Full stack reset - complete wipe and fresh start"""
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
        print(result[:4000])
    return result

print("Connecting...")
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD, timeout=30)
print("Connected!\n")

# Step 1: Full stack down (removes containers)
print("=== Step 1: Full docker compose down ===")
run(ssh, "cd /opt/cspanel && docker compose down 2>&1")
time.sleep(3)

# Step 2: Remove the old MySQL data volume
print("\n=== Step 2: Remove old MySQL volume ===")
run(ssh, "docker volume ls | grep mysql")
run(ssh, "docker volume rm cs-mysql-data 2>&1 || true")
run(ssh, "docker volume ls | grep mysql || echo 'Volume removed OK'")

# Step 3: Verify .env has correct password
print("\n=== Step 3: Verify .env ===")
run(ssh, "grep MYSQL /opt/cspanel/.env")

# Step 4: Start fresh
print("\n=== Step 4: Starting fresh stack ===")
run(ssh, "cd /opt/cspanel && docker compose up -d 2>&1", timeout=120)

# Step 5: Wait for MySQL first-time init (needs ~45-60s on fresh volume)
print("\n=== Step 5: Waiting 60s for MySQL first-time init... ===")
for i in range(6):
    time.sleep(10)
    print(f"  {(i+1)*10}s elapsed...")
    out = run(ssh, "docker inspect cs-mysql --format='{{.State.Health.Status}}' 2>/dev/null", show=False)
    if 'healthy' in out:
        print(f"  MySQL is healthy!")
        break

# Step 6: Test MySQL connection with our password
print("\n=== Step 6: Testing MySQL connection ===")
out = run(ssh, "docker exec cs-mysql mysql -uroot -pcs_root_2024 -e \"SELECT user, host FROM mysql.user WHERE user='root';\" 2>&1")

if 'ERROR' in out:
    print("\n[!] cs_root_2024 still failing - trying to find correct password...")
    # Try reading from Docker inspect env
    run(ssh, "docker inspect cs-mysql --format='{{range .Config.Env}}{{println .}}{{end}}' | grep MYSQL_ROOT")
    
    # Try with empty password
    out2 = run(ssh, "docker exec cs-mysql mysql -uroot --password='' -e \"SHOW DATABASES;\" 2>&1")
    if 'ERROR' not in out2:
        print("Empty password works! Resetting to cs_root_2024...")
        run(ssh, "docker exec cs-mysql mysql -uroot --password='' -e \"ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'cs_root_2024'; ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'cs_root_2024'; FLUSH PRIVILEGES;\" 2>&1")
else:
    print("MySQL connection OK with cs_root_2024!")
    # Grant root@% access
    print("\n=== Step 7: Granting root@% ===")
    fix_sql = (
        "CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'cs_root_2024';"
        "ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password BY 'cs_root_2024';"
        "GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;"
        "FLUSH PRIVILEGES;"
    )
    run(ssh, f"docker exec cs-mysql mysql -uroot -pcs_root_2024 -e \"{fix_sql}\" 2>&1")

# Step 8: Restart cs-panel to pick up MySQL fix
print("\n=== Step 8: Restart cs-panel ===")
run(ssh, "docker restart cs-panel 2>&1")
print("Waiting 15s...")
time.sleep(15)

# Step 9: Final status
print("\n=== FINAL STATUS ===")
run(ssh, "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'")

print("\n=== cs-panel logs ===")
run(ssh, "docker logs cs-panel --tail 20 2>&1")

print("\n=== API test ===")
run(ssh, "curl -s http://127.0.0.1:3000/ 2>&1 | head -c 200")
run(ssh, "curl -s http://127.0.0.1:3000/api/servers/public 2>&1 | head -c 300")

ssh.close()
print("\nDone!")
