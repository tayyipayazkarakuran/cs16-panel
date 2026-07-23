import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

def query(sql):
    cmd = f"docker exec cs-mysql mysql -uroot -pcs_root_2024 -e \"{sql}\""
    _, stdout, stderr = ssh.exec_command(cmd)
    return stdout.read().decode('utf-8', errors='replace') + stderr.read().decode('utf-8', errors='replace')

print("=== DESCRIBE panel_users ===")
print(query("DESCRIBE cs_panel.panel_users;"))

print("=== DESCRIBE panel_servers ===")
print(query("DESCRIBE cs_panel.panel_servers;"))

ssh.close()
