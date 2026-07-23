import urllib.request
import urllib.parse
import json

CF_API_TOKEN = "your-cloudflare-api-token"
ZONE_NAME = "example.com"
IP_ADDR = "YOUR_SERVER_IP"

def make_request(url, method="GET", data=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {CF_API_TOKEN}")
    req.add_header("Content-Type", "application/json")
    if data:
        jsondata = json.dumps(data).encode("utf-8")
        req.data = jsondata
    try:
        with urllib.request.urlopen(req) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP Error {e.code}: {e.read().decode('utf-8')}")
        raise e

def get_zone_id():
    url = f"https://api.cloudflare.com/client/v4/zones?name={ZONE_NAME}"
    res = make_request(url)
    if res["success"] and res["result"]:
        return res["result"][0]["id"]
    raise Exception(f"Failed to find zone: {ZONE_NAME}")

def get_dns_records(zone_id):
    url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?per_page=100"
    res = make_request(url)
    return res["result"] if res["success"] else []

def create_or_update_record(zone_id, records, name, type_, content, proxied=True):
    fqdn = name if name.endswith(ZONE_NAME) else f"{name}.{ZONE_NAME}"
    existing = [r for r in records if r["name"] == fqdn and r["type"] == type_]
    
    data = {
        "type": type_,
        "name": fqdn,
        "content": content,
        "ttl": 1, # Auto
        "proxied": proxied
    }
    
    if existing:
        record_id = existing[0]["id"]
        # Update if different
        if existing[0]["content"] != content or existing[0]["proxied"] != proxied:
            print(f"Updating {fqdn} -> {content} (proxied={proxied})")
            url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}"
            make_request(url, "PATCH", data)
        else:
            print(f"Record {fqdn} is already correct.")
    else:
        print(f"Creating {fqdn} -> {content} (proxied={proxied})")
        url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records"
        make_request(url, "POST", data)

def main():
    print("Connecting to Cloudflare API...")
    try:
        zone_id = get_zone_id()
        print(f"Zone ID for {ZONE_NAME}: {zone_id}")
        
        records = get_dns_records(zone_id)
        print(f"Found {len(records)} existing DNS records.")
        
        # 1. cs.example.com -> A -> Direct IP (MUST be DNS Only for UDP)
        create_or_update_record(zone_id, records, "cs", "A", IP_ADDR, proxied=False)
        
        # 2. mysql.example.com -> A -> Direct IP (MUST be DNS Only for TCP port 3306)
        create_or_update_record(zone_id, records, "mysql", "A", IP_ADDR, proxied=False)
        
        # 3. example.com -> A -> Proxied (For HTTP/HTTPS landing)
        create_or_update_record(zone_id, records, "@", "A", IP_ADDR, proxied=True)
        
        # 4. panel.example.com -> A -> Proxied (For panel SPA)
        create_or_update_record(zone_id, records, "panel", "A", IP_ADDR, proxied=True)
        
        # 5. fastdl.example.com -> A -> Proxied (For fastdl HTTP files)
        create_or_update_record(zone_id, records, "fastdl", "A", IP_ADDR, proxied=True)
        
        # 6. www.example.com -> A -> Proxied
        create_or_update_record(zone_id, records, "www", "A", IP_ADDR, proxied=True)
        
        # 7. pro15.example.com -> A -> Proxied
        create_or_update_record(zone_id, records, "pro15", "A", IP_ADDR, proxied=True)
        
        print("Cloudflare DNS configured successfully!")
    except Exception as e:
        print(f"Error configuring Cloudflare: {e}")

if __name__ == "__main__":
    main()
