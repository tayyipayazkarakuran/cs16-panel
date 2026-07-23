# CS 1.6 Server Panel — Project Handoff Document

This document summarizes the current status, architecture, features, and next steps for the CS 1.6 Server Rental & Management Panel. It is prepared for the next AI agent or developer taking over the project.

---

## 🏗️ System Architecture & Docker Stack

The panel and its supporting infrastructure have been fully containerized and grouped using Docker Compose.

```
Docker Compose Stack (cs-network bridge network):
├── cs-panel        (Node.js Panel API)   → Port 3000  → Mounts /var/run/docker.sock
├── cs-fastdl       (Nginx Web Server)    → Port 8080  → Mounts volume: fastdl-data
├── cs-mysql        (MySQL 8.0 DB)        → Port 3306  → Mounts volume: mysql-data
└── cs-php          (PHP 8.2 & Apache)    → Port 8081  → Mounts volume: php-www

Dynamic Game Containers:
└── cs16-server-{port} (ReHLDS server)    → Port {port} (TCP/UDP) → Joins cs-network
```

### Shared Volumes & Filesystems
*   **`fastdl-data`**: Shared between `cs-panel` (writes files via direct sync API) and `cs-fastdl` (serves them read-only over HTTP on port 8080).
*   **`php-www`**: Shared between `cs-panel` (manages files via file manager API) and `cs-php` (executes Apache PHP scripts).
*   **`mysql-data`**: Dedicated database storage for `cs-mysql`.

---

## 🛠️ Implemented Features & Core Logic

### 1. Web Panel & Docker Integration
*   **Dockerode Integration**: The panel interacts directly with `/var/run/docker.sock` to start, stop, restart, delete, and inspect containers.
*   **Dynamic Port Allocation**: Starts from port `27018` and automatically binds the next free port on the host machine.
*   **Docker Network Resolution Bug Fix**: When containerized, the panel cannot query containers using `127.0.0.1` because localhost refers to the panel container itself. We implemented `queryHelper.getServerIp()` which dynamically checks if running in docker (`/.dockerenv`) and extracts the target container's bridge network IP address (`cs-network`) for all UDP & RCON requests.

### 2. FastDL (Fast HTTP Downloads)
*   **Automatic Setup**: When a server container is created, its `SV_DOWNLOADURL` env variable is automatically set to `http://<FASTDL_HOST>:8080/<port>/`.
*   **Automatic Directories**: Creates folders for `maps`, `models`, `sounds`, `sprites`, `gfx` in the FastDL volume for each port.
*   **Sync API (`/api/fastdl/:port/sync`)**: Directly reads maps, models, and sprite assets from inside the running game container using docker exec stream pipelines, encodes them in base64, and writes them to the FastDL Nginx directory.

### 3. MySQL Database Management
*   **Panel Integration**: Connects to the `cs-mysql` container via the `mysql2/promise` driver.
*   **Operations**:
    *   List databases.
    *   Create / Drop databases (restricted to alphanumeric names).
    *   List users.
    *   Create user + Grant privileges on a specific database.
    *   Delete users (restricted from dropping root).
    *   Raw SQL runner (restricted to SELECT, SHOW, DESCRIBE, EXPLAIN for safety).

### 4. PHP Apache Container & File Manager
*   **Operations**:
    *   File manager API allowing directory listing, file viewing, file creation/saving, uploads, and deletions directly in `/php-www`.
    *   PHP container status check and restart action.

### 5. Server Clean Reset (Wipe & Reinstall)
*   **Operations**:
    *   API endpoint (`/api/servers/:id/reset`) which stops the container, completely removes its volume (`cs16-server-<port>-cstrike`), and starts it again.
    *   The entrypoint detects the empty volume and copies a fresh copy of `/hlds_clean` (ReHLDS, AMX Mod X, Metamod, Reunion, Reunion settings, Reunion API plugins, etc.) to rebuild the server data without losing container configurations.

### 6. UI & Frontend Polish
*   **F5 Page State Persistence**: App state (`currentPage`, `activeServerId`, `activeTab`) is persisted using `localStorage` on the client. F5 refresh keeps you on the same subpage or tab.
*   **Grid Layout**: Rebuilt entirely with safe HTML tables and vanilla CSS. There are no fancy flex overflows or overlapping elements. Emojis and aesthetic clutter have been stripped to keep it neat, tabular, and flat.

---

## ⚡ Current System Status & Verification

1.  **Running Containers**:
    *   `cs-panel` is running and accessible on **`http://localhost:3000`**.
    *   `cs-fastdl` is serving directory indexes on port **`8080`**.
    *   `cs-mysql` is healthy on port **`3306`**.
    *   `cs-php` is running Apache on port **`8081`**.
    *   `cs16-server-27018` is running and connected to `cs-network`.
2.  **API Verification**:
    *   `GET /api/servers` successfully resolves the game container IP, pings it, and returns active player count, 900+ server FPS, and active CPU usage.
    *   `GET /api/mysql/status` returns `{"online": true}`.
    *   `GET /api/fastdl/status` returns `{"available": true}`.
    *   `POST /api/fastdl/27018/sync` successfully copied and served all resources.

---

## 🎯 Next Steps & Recommendations for the Takeover Agent

1.  **Rental & User System**:
    *   Currently, the panel is a single-user prototype.
    *   Implement user authentication (signup, login, JWT sessions).
    *   Add user roles (User vs. Admin). Users should only see and control the servers they rent.
    *   Add a mock wallet/balance system or billing/rental flow (e.g. rent a server for $X/month, automated expiration timer that stops the docker container).
2.  **Security Hardening**:
    *   The raw SQL runner only permits `SELECT` but is still vulnerable if not isolated properly. Secure this endpoint or restrict it to admin-only.
    *   Ensure proper RCON password rotation and hide sensitive credentials from general API responses.
3.  **UI Refinements**:
    *   The UI is functional and clean. You can add more detailed server controls (like editing `amxx.cfg` or `motd.txt` directly through a text editor UI tab).
