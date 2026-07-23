import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

def run(cmd):
    print(f"$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    res = (out + err).strip()
    if res:
        print(res)
    return res

# 1. Create webroot directory
run("mkdir -p /var/www/html")

# 2. Run certbot
print("\n=== Acquiring SSL Certificates via Certbot HTTP-01 ===")
certbot_cmd = (
    "certbot certonly --webroot -w /var/www/html "
    "--agree-tos --email admin@example.com --no-eff-email --non-interactive "
    "-d example.com -d www.example.com -d panel.example.com -d fastdl.example.com"
)
run(certbot_cmd)

# 3. Check if certificates exist
print("\n=== Checking generated certs ===")
run("ls -la /etc/letsencrypt/live/example.com/ || echo 'Certificates NOT found'")

ssh.close()
