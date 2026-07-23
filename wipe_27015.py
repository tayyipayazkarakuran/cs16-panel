import paramiko

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD)
print("Connected!")

def run(cmd):
    print(f"$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    res = (out + err).strip()
    if res:
        print(f"  {res}")
    return res

# 1. Stop and remove container cs16-server-27015
print("\n=== Removing container cs16-server-27015 ===")
run("docker rm -f cs16-server-27015 || true")

# 2. Force remove volume cs16-server-27015-cstrike
print("\n=== Removing volume cs16-server-27015-cstrike ===")
run("docker volume rm cs16-server-27015-cstrike || true")

# 3. Check if volume was deleted successfully
print("\n=== Verification ===")
run("docker volume ls | grep cs16-server || echo 'No leftover volumes found'")

ssh.close()
print("\nDone!")
