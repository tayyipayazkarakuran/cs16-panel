import paramiko, sys, subprocess, os, time

HOST = "YOUR_SERVER_IP"
USER = "root"
PASS = "YOUR_SSH_PASSWORD"

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=PASS, timeout=15)

def safe_print(text):
    try:
        print(text.encode(sys.stdout.encoding, errors='replace').decode(sys.stdout.encoding))
    except Exception:
        print(text.encode('utf-8', errors='replace').decode('utf-8', errors='replace'))

print("=== 1. Installing Nginx on Live Server ===")
stdin, stdout, stderr = client.exec_command("apt-get update && apt-get install -y nginx")
safe_print(stdout.read().decode('utf-8', errors='replace'))
safe_print(stderr.read().decode('utf-8', errors='replace'))

print("=== 2. Creating Nginx Site Configuration ===")
nginx_conf = """# Nginx Routing Configuration for example.com

# 1. Root & Panel Yönlendirmesi
server {
    listen 80;
    server_name example.com www.example.com panel.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Enable websocket support for console stream
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}

# 2. FastDL Yönlendirmesi
server {
    listen 80;
    server_name fastdl.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        client_max_body_size 100M;
    }
}

# 3. Dinamik PHP Subdomain Yönlendirmesi (php-[PORT].example.com)
server {
    listen 80;
    server_name ~^php-(?<srv_port>\\d+)\\.eskidostlar\\.site$;

    location / {
        proxy_pass http://127.0.0.1:3000/api/php/proxy/$srv_port$request_uri;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        proxy_read_timeout 90;
        proxy_connect_timeout 90;
    }
}
"""

# Write configuration
sftp = client.open_sftp()
conf_file = sftp.file("/etc/nginx/sites-available/eskidostlar.conf", "w")
conf_file.write(nginx_conf)
conf_file.close()
sftp.close()

print("=== 3. Enabling Configuration & Cleaning default Site ===")
# Link configuration and delete default site config to prevent ports overlap
client.exec_command("ln -sf /etc/nginx/sites-available/eskidostlar.conf /etc/nginx/sites-enabled/eskidostlar.conf")
client.exec_command("rm -f /etc/nginx/sites-enabled/default")

print("=== 4. Starting Nginx Service ===")
stdin, stdout, stderr = client.exec_command("systemctl restart nginx && systemctl enable nginx")
safe_print(stdout.read().decode('utf-8', errors='replace'))
safe_print(stderr.read().decode('utf-8', errors='replace'))

print("=== 5. Checking Active Ports after Nginx setup ===")
stdin, stdout, stderr = client.exec_command("ss -tlnp | grep ':80'")
safe_print(stdout.read().decode('utf-8', errors='replace'))

client.close()
print("DONE")
