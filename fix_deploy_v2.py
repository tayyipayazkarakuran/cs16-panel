# Read the actual nginx-panel.conf content
with open('nginx-panel.conf', 'r', encoding='utf-8') as f:
    nginx_conf_content = f.read()

# Read deploy_v2.py
with open('deploy_v2.py', 'r', encoding='utf-8') as f:
    deploy_content = f.read()

# Locate the markers
start_marker = '    nginx_conf = r"""'
end_marker = '"""'

start_idx = deploy_content.find(start_marker)
if start_idx == -1:
    print("Start marker not found")
    exit(1)

# Find the next """ after the start marker
end_idx = deploy_content.find(end_marker, start_idx + len(start_marker))
if end_idx == -1:
    print("End marker not found")
    exit(1)

# Construct new Nginx conf block
nginx_conf_block = '    nginx_conf = r"""\n' + nginx_conf_content.strip() + '\n"""'

# Replace in deploy_v2.py
new_content = deploy_content[:start_idx] + nginx_conf_block + deploy_content[end_idx + len(end_marker):]

with open('deploy_v2.py', 'w', encoding='utf-8') as f:
    f.write(new_content)

print("Successfully updated deploy_v2.py with the contents of nginx-panel.conf!")
