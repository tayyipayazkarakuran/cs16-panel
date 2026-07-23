import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

def query(sql):
    cmd = f"docker exec cs-mysql mysql -uroot -pcs_root_2024 -e \"{sql}\""
    _, stdout, stderr = ssh.exec_command(cmd)
    return stdout.read().decode('utf-8', errors='replace') + stderr.read().decode('utf-8', errors='replace')

print("=== Users before refund ===")
print(query("SELECT id, username, balance FROM cs_panel.panel_users;"))

# 1. Clear panel_servers
print("\n=== Clearing panel_servers ===")
print(query("DELETE FROM cs_panel.panel_servers;"))

# 2. Drop cs_srv_27015 database if exists
print("\n=== Dropping database ===")
print(query("DROP DATABASE IF EXISTS cs_srv_27015;"))

# 3. Set users balance to 1000.00
print("\n=== Setting users balance ===")
print(query("UPDATE cs_panel.panel_users SET balance = 1000.00;"))

print("\n=== Verification ===")
print(query("SELECT id, username, balance FROM cs_panel.panel_users;"))
print(query("SELECT * FROM cs_panel.panel_servers;"))

ssh.close()
