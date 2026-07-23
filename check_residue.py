import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

def run(cmd):
    _, out, _ = ssh.exec_command(cmd)
    return out.read().decode('utf-8', errors='replace').strip()

print("=== fastdl-data ===")
print(run("ls -la /opt/cspanel/fastdl-data 2>/dev/null || echo 'not found'"))

print("=== php-www ===")
print(run("ls -la /opt/cspanel/php-www 2>/dev/null || echo 'not found'"))

ssh.close()
