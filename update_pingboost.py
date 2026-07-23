import paramiko
import os

HOST = "YOUR_SERVER_IP"
USER = "root"
PASSWORD = "YOUR_SSH_PASSWORD"
LOCAL_ENTRYPOINT = r"c:\Users\TayyipPC\Desktop\cspanel\entrypoint.sh"
LOCAL_REUNION = r"c:\Users\TayyipPC\Desktop\cspanel\files\reunion.cfg"

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASSWORD)
print("Connected to server!")

sftp = ssh.open_sftp()

# Upload entrypoint.sh and reunion.cfg
print("Uploading entrypoint.sh and reunion.cfg...")
sftp.put(LOCAL_ENTRYPOINT, "/tmp/entrypoint.sh")
sftp.put(LOCAL_REUNION, "/tmp/reunion.cfg")
sftp.close()

def run(cmd):
    print(f"$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    res = (out + err).strip()
    if res:
        print(f"  {res}")
    return res

# 1. Clean line endings
run("sed -i 's/\\r$//' /tmp/entrypoint.sh && chmod +x /tmp/entrypoint.sh")
run("sed -i 's/\\r$//' /tmp/reunion.cfg")

# 2. Check if temp-container exists and remove it
run("docker rm -f temp-container 2>/dev/null || true")

# 3. Create temp container
print("\nCreating temporary container from cs16-server-base...")
run("docker create --name temp-container cs16-server-base")

# 4. Copy updated files
print("\nCopying files to container...")
run("docker cp /tmp/entrypoint.sh temp-container:/hlds/entrypoint.sh")
run("docker cp /tmp/reunion.cfg temp-container:/hlds/reunion.cfg")

# 5. Commit container back to image
print("\nCommitting changes back to cs16-server-base image...")
run("docker commit temp-container cs16-server-base")

# 6. Remove temp container
run("docker rm temp-container")

# 7. Restart all active game servers to apply fix
print("\nRestarting game server containers to apply pingboost 2 update...")
containers_out = run("docker ps --filter 'ancestor=cs16-server-base' --format '{{.ID}}'").strip()
if containers_out:
    container_ids = containers_out.split('\n')
    for cid in container_ids:
        cid = cid.strip()
        if cid:
            print(f"Restarting container: {cid}")
            run(f"docker restart {cid}")
else:
    print("No active game server containers found.")

print("\nVerification - showing logs of game servers:")
run("docker ps --filter 'ancestor=cs16-server-base' --format 'table {{.Names}}\t{{.Status}}'")
# Show logs of first game server to verify
run("docker ps --filter 'ancestor=cs16-server-base' --format '{{.Names}}' | head -n 1 | xargs -I {} sh -c 'echo === Logs for {} === && docker logs {} --tail 15'")

ssh.close()
print("\nDone!")
