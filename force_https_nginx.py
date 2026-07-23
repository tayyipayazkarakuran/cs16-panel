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

print("=== 1. Writing HTTPS Enforced Nginx Configuration ===")
nginx_conf = """# SSL Enforced Nginx Routing Configuration for example.com

# HTTP to HTTPS Redirect
server {
    listen 80;
    server_name example.com www.example.com panel.example.com fastdl.example.com;
    return 301 https://$host$request_uri;
}

# HTTP to HTTPS Redirect for dynamic PHP subdomains
server {
    listen 80;
    server_name ~^php-(?<srv_port>\\d+)\\.eskidostlar\\.site$;
    return 301 https://$host$request_uri;
}

# 1. Root & Panel Yönlendirmesi (HTTPS)
server {
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

# 2. FastDL Yönlendirmesi (HTTPS)
server {
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

# 3. Dinamik PHP Subdomain Yönlendirmesi (HTTPS)
server {
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

print("=== 2. Restarting Nginx ===")
stdin, stdout, stderr = client.exec_command("systemctl restart nginx")
safe_print(stdout.read().decode('utf-8', errors='replace'))
safe_print(stderr.read().decode('utf-8', errors='replace'))

print("=== 3. Verifying HTTP to HTTPS redirection rule ===")
stdin, stdout, stderr = client.exec_command("curl -s -I http://localhost/ | grep -i 'Location'")
safe_print(stdout.read().decode('utf-8', errors='replace'))

client.close()
print("DONE")
