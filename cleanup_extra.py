import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

# Remove dangling containers
extra_containers = ['dreamy_gould', 'nervous_shannon', 'dreamy_roentgen']
for name in extra_containers:
    print(f"Removing container: {name}")
    _, stdout, stderr = ssh.exec_command(f"docker rm -f {name}")
    print(stdout.read().decode('utf-8') + stderr.read().decode('utf-8'))

ssh.close()
print("Done!")
