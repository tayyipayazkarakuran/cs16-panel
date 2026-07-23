import paramiko, sys, subprocess, os

HOST = "YOUR_SERVER_IP"
USER = "root"
PASS = "YOUR_SSH_PASSWORD"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASS, timeout=15)

print("=== Allowing Port 80 and 443 in UFW Firewall ===")
stdin, stdout, stderr = client.exec_command("ufw allow 80/tcp")
print(stdout.read().decode())
print(stderr.read().decode())

stdin, stdout, stderr = client.exec_command("ufw allow 443/tcp")
print(stdout.read().decode())
print(stderr.read().decode())

print("=== Reloading UFW firewall ===")
stdin, stdout, stderr = client.exec_command("ufw reload")
print(stdout.read().decode())
print(stderr.read().decode())

print("=== Updated UFW Status ===")
stdin, stdout, stderr = client.exec_command("ufw status")
print(stdout.read().decode())

client.close()
print("DONE")
