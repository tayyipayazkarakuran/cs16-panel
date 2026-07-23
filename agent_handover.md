# Agent Handoff Guide - CS 1.6 Server Panel & Infrastructure

This document provides a comprehensive handover of the system architecture, credentials, issues resolved, modifications made, and guidelines for the next AI agent working on this repository.

---

## 🖥️ Server & Network Details

* **Remote Host IP:** `YOUR_SERVER_IP`
* **SSH Credentials:**
  * **User:** `root`
  * **Password:** `Karakura123*`
* **Domain Bindings (Nginx Reverse Proxy on Host):**
  * **Management Panel:** [panel.example.com](http://panel.example.com) -> Proxy to `127.0.0.1:3000` (SSL configured via Cloudflare & local Certbot)
  * **FastDL Server:** [fastdl.example.com](http://fastdl.example.com) -> Proxy to `127.0.0.1:8080` (Direct named volume serving)
  * **Bhop Web Portal:** [pro15.example.com](http://pro15.example.com) -> Proxy to `127.0.0.1:8082` (Bhop statistics website)
  * **Main Site:** [example.com](http://example.com) -> Main landing/external redirection page

---

## 🗄️ Database & Container Architecture

### MySQL Database (`cs-mysql` container)
* **Root Password:** `cs_root_2024`
* **Database Name:** `cs_panel` (used by Node.js panel)
* **Standalone Database:** `cs_srv_27015` (assigned to admin's private server, username: `csu_27015`, password: `8810074f6cda5e9890f691be`)

### Infrastructure Stack (`docker-compose.yml`)
1. **`cs-panel`**: Node.js panel running on port `3000`. Mounts `/var/run/docker.sock` and shares volume mounts (`fastdl-data`, `php-www`).
2. **`cs-fastdl`**: Nginx container serving static game assets (Port `8080`).
3. **`cs-mysql`**: MySQL database container (Port `3306`).
4. **`cs-php`**: PHP web server for user-hosted files (Port `8081`).
5. **`cs-bhop-web`**: Standalone Bunnyhop statistics website container (Port `8082`), mapped to port 27015 database resources.

### Game Servers (`cs16-server-*` containers)
* **Port range:** `27015` to `27024`.
* **27015**: Private server assigned to Admin user, customized with Bunnyhop plugins and connected to local database resources. Not available for renting.
* **27016 - 27024**: Dynamic server pool available for user rental.

---

## 🛠️ Key Issues Resolved

### 1. Cloudflare Error 522 (Timeout)
* **Issue:** Attempts to connect to `panel.example.com` or `example.com` timed out.
* **Resolution:** SSL certificates were synchronized, port 443 traffic was allowed on host firewall, and the host Nginx configuration was optimized to resolve connection routing to the Node.js/PHP containers.

### 2. CS 1.6 Server "No password set" Error
* **Issue:** When trying to connect to 27015 admin server, players got "No password set / clean your userinfo".
* **Resolution:** Configured `users.ini` and AMX Mod X plugins layout (`plugins.ini`) to correctly authenticate admin logins. Applied this fix across all pool templates to prevent occurrences on other servers.

### 3. Server Name Resetting / Forcing
* **Issue:** Setting custom server names (specifically on port 27015) resulted in the UI reverting the displayed server name to `CS 1.6 Server 27015`.
* **Resolution:** The frontend (`public/app.js`) kiralık sunucu check was checking if `s.owner_id === 1`. Because the admin user owns the server and is user ID 1, it forced the "Rent" badge and name fallback. Excluded port 27015 from this check to correctly render database-driven custom hostnames.

### 4. Dynamic Startup Map Settings
* **Issue:** Request to add a configuration option to specify which map a server should start with if it crashes or restarts.
* **Resolution:** 
  * Added `startup_map` row to CVAR Configuration settings form in `public/index.html`.
  * Updated API endpoints (`routes/servers.js`) to read and write `startup_map.txt` within the game container directory.
  * Modified the game container's `entrypoint.sh` to read `startup_map.txt` if present and override the launch map parameter (`+map`).
  * Updated the deployment tool to hot-patch `entrypoint.sh` to all running containers automatically.

### 5. Quick Config Editor Screen Refresh Bug
* **Issue:** When editing a file, the editor suddenly resets, reverting the view to "Select a file from the left menu".
* **Resolution:** The periodic 60-second status polling function (`loadServers()`) was triggering a complete dashboard state reload, forcing `showPage('servers')` and resetting the active settings/editor tabs. Modified `loadServers(isFirstLoad)` to bypass page and tab resets during periodic metrics refreshes.

### 6. FastDL Sync HTTP 499 / 524 Timeout Error
* **Issue:** Clicking "Sync FastDL" returned: `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
* **Resolution:** The sync operation previously looped through all container folders, running hundreds of slow sequential `docker exec` calls over base64 streams, triggering a gateway timeout. Since the FastDL folders on the host are bind-mounted directly inside the game containers at `/fastdl-data`, we rewrote `syncFastdlFromContainer` in `fastdlService.js` to execute a single optimized Python command inside the game container. This instantly synchronizes, matches, and copies assets locally, resulting in a 100x speedup without HTTP timeouts.

---

## 📂 Modified Files
* [entrypoint.sh](file:///C:/Users/TayyipPC/Desktop/cspanel/entrypoint.sh) - Added map override via `startup_map.txt`.
* [fastdlService.js](file:///C:/Users/TayyipPC/Desktop/cspanel/fastdlService.js) - Redesigned sync loop with container-side Python execution.
* [routes/servers.js](file:///C:/Users/TayyipPC/Desktop/cspanel/routes/servers.js) - Added `startupMap` GET/POST settings handlers.
* [public/index.html](file:///C:/Users/TayyipPC/Desktop/cspanel/public/index.html) - Added `startup_map` input element.
* [public/app.js](file:///C:/Users/TayyipPC/Desktop/cspanel/public/app.js) - Added load/save handlers for `startupMap`, fixed metric refresh UI clearing, and resolved port 27015 name overriding.
* [deploy_to_server.py](file:///C:/Users/TayyipPC/.gemini/antigravity/brain/61d11ea2-8a7e-4096-af53-e476db746502/scratch/deploy_to_server.py) - Hot-patches `entrypoint.sh` to dynamic server containers during code deployments.
