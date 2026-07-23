import paramiko

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD)
print("Connected to host!")

def run(cmd):
    print(f"$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    res = (out + err).strip()
    if res:
        print(f"  {res}")
    return res

# 1. Back up /etc/sysctl.conf
run("cp /etc/sysctl.conf /etc/sysctl.conf.bak")

# 2. Append optimizations to /etc/sysctl.conf
sysctl_opts = """
# CS 1.6 Game Server Networking Optimizations (1000 FPS Support)
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.core.netdev_max_backlog = 100000
net.core.somaxconn = 65535
net.ipv4.udp_rmem_min = 16384
net.ipv4.udp_wmem_min = 16384
"""

# We can append it cleanly using cat
print("\nAppending optimizations to /etc/sysctl.conf...")
# Escape newlines
escaped_opts = sysctl_opts.replace("'", "'\\''")
run(f"echo '{escaped_opts}' >> /etc/sysctl.conf")

# 3. Apply sysctl changes
print("\nApplying sysctl changes...")
run("sysctl -p")

# 4. Verify
print("\nVerifying applied changes:")
run("sysctl net.core.rmem_max net.core.wmem_max net.core.netdev_max_backlog")

ssh.close()
print("\nDone!")
