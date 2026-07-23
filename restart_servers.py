import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('YOUR_SERVER_IP', username='root', password='YOUR_SSH_PASSWORD')

# 1. Get all cs16-server containers
_, stdout, _ = ssh.exec_command('docker ps -a --filter "name=cs16-server-" --format "{{.Names}}"')
names = stdout.read().decode('utf-8').strip().split()

print(f"Found containers: {names}")

# 2. Stop and remove them. The panel will allow recreating them, or we can just restart them.
# Wait, if we just restart them, does Docker reload the updated image layers?
# No! In Docker, when you do "docker restart", it restarts the existing container instance, which is instantiated from the old image layer!
# To run a container with the new updated image, the container MUST be deleted and recreated!
# Since the panel provides a "Clean Reset" or we can delete and recreate it from the panel, or we can do it via API, let's just delete the container, and the panel database record is still there so the user can just click "Start" or "Reset" from the panel and it will recreate it using the new image!
# Or we can do: docker rm -f and let the panel detect it as stopped, and when the user clicks Start it will create a new container from the updated cs16-server-base image!
# Yes! The start/create logic in routes/servers.js automatically creates a new container if it doesn't exist!
# So deleting the container is perfect: it forces the panel to recreate it from the new image when started.

for name in names:
    name = name.strip()
    if name:
        print(f"Stopping and removing container: {name}")
        _, stdout, stderr = ssh.exec_command(f"docker rm -f {name}")
        print(stdout.read().decode('utf-8') + stderr.read().decode('utf-8'))

ssh.close()
print("Done!")
