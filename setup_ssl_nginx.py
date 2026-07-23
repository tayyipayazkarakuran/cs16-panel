import paramiko, sys, subprocess, os

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

print("=== 1. Generating Self-Signed SSL Certificate on Live Server ===")
cmd_ssl = (
    'openssl req -x509 -nodes -days 365 -newkey rsa:2048 '
    '-keyout /etc/ssl/private/nginx-selfsigned.key '
    '-out /etc/ssl/certs/nginx-selfsigned.crt '
    '-subj "/C=TR/ST=Istanbul/L=Istanbul/O=Eskidostlar/OU=IT/CN=example.com"'
)
stdin, stdout, stderr = client.exec_command(cmd_ssl)
safe_print(stdout.read().decode('utf-8', errors='replace'))
safe_print(stderr.read().decode('utf-8', errors='replace'))

print("=== 2. Creating SSL Supported Nginx Site Configuration ===")
nginx_conf = """# SSL & HTTP Nginx Routing Configuration for example.com

# 1. Root & Panel Yönlendirmesi (HTTP + HTTPS)
server {
    listen 80;
    listen 443 ssl;
    server_name example.com www.example.com panel.example.com;

    ssl_certificate /etc/ssl/certs/nginx-selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/nginx-selfsigned.key;

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

# 2. FastDL Yönlendirmesi (HTTP + HTTPS)
server {
    listen 80;
    listen 443 ssl;
    server_name fastdl.example.com;

    ssl_certificate /etc/ssl/certs/nginx-selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/nginx-selfsigned.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        client_max_body_size 100M;
    }
}

# 3. Dinamik PHP Subdomain Yönlendirmesi (HTTP + HTTPS)
server {
    listen 80;
    listen 443 ssl;
    server_name ~^php-(?<srv_port>\\d+)\\.eskidostlar\\.site$;

    ssl_certificate /etc/ssl/certs/nginx-selfsigned.crt;
    ssl_certificate_key /etc/ssl/private/nginx-selfsigned.key;

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

sftp = client.open_sftp()
conf_file = sftp.file("/etc/nginx/sites-available/eskidostlar.conf", "w")
conf_file.write(nginx_conf)
conf_file.close()
sftp.close()

print("=== 3. Restarting Nginx ===")
stdin, stdout, stderr = client.exec_command("systemctl restart nginx")
safe_print(stdout.read().decode('utf-8', errors='replace'))
safe_print(stderr.read().decode('utf-8', errors='replace'))

print("=== 4. Checking Active Ports (80 & 443 check) ===")
stdin, stdout, stderr = client.exec_command("ss -tlnp | grep -E ':80|:443'")
safe_print(stdout.read().decode('utf-8', errors='replace'))

client.close()
print("DONE")
