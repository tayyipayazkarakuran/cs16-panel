import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

def query(sql):
    cmd = f"docker exec cs-mysql mysql -uroot -pcs_root_2024 -e \"{sql}\""
    _, stdout, stderr = ssh.exec_command(cmd)
    return stdout.read().decode('utf-8') + stderr.read().decode('utf-8')

print("=== Databases ===")
print(query("SHOW DATABASES;"))

print("=== panel_users ===")
print(query("SELECT id, username, role FROM cs_panel.panel_users;"))

print("=== panel_servers ===")
print(query("SELECT * FROM cs_panel.panel_servers;"))

ssh.close()
