# CS 1.6 Server Management Panel — System Overview

> Full-stack Counter-Strike 1.6 game server rental & management platform.
> Node.js/Express backend, vanilla JS SPA frontend, Docker-based isolation.

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          PUBLIC (Internet)                          │
│                                                                     │
│   Landing Page ──┐                       ┌── Panel SPA              │
│   (landing.html) │   ┌───────────┐       │ (index.html + app.js)    │
│                  ├───│  Reverse Proxy  │───┤                          │
│   Canlı Sunucu   │   │  (Nginx)   │   │  Auth, Dashboard,         │
│   Listesi        │   └──────┬───────┘   │  File Manager, Console,   │
│   Fiyatlar       │          │           │  Plugins, Maps, FastDL,   │
│   Özellikler     │          │           │  MySQL, PHP, Billing      │
└──────────────────┼──────────┼───────────┼────────────────────────────┘
                   │          │           │
┌──────────────────▼──────────▼───────────▼────────────────────────────┐
│                     BACKEND (Node.js / Express)                       │
│                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────────┐  │
│  │  server.js   │  │   panelDb    │  │  routes/                     │  │
│  │ (entrypoint) │  │  (MySQL DB   │  │  servers.js   files.js      │  │
│  │              │  │   layer,     │  │  plugins.js   maps.js        │  │
│  │ Auth (JWT)   │  │   auth,      │  │  admins.js    players.js    │  │
│  │ CORS         │  │   tokens,    │  │  fastdl.js    mysql.js      │  │
│  │ WebSocket    │  │   billing)   │  │  php.js       phpProxy.js   │  │
│  │ Express      │  │              │  │  payments.js  admin.js       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┬──────────────┘  │
│         │                 │                          │                 │
│  ┌──────▼─────────────────▼──────────────────────────▼──────┐        │
│  │               Helper Modules                              │        │
│  │  queryHelper.js    (UDP queries, RCON to game servers)    │        │
│  │  fastdlService.js  (FastDL file sync from containers)      │        │
│  │  containerFsHelper.js (container filesystem ops)          │        │
│  │  poolService.js    (10 always-on server pool management)  │        │
│  └───────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                    Docker Engine │ (dockerode)
                                  │
┌─────────────────────────────────▼─────────────────────────────────────┐
│                    DOCKER COMPOSE INFRASTRUCTURE                       │
│                                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ cs-panel  │  │cs-fastdl │  │ cs-mysql  │  │  cs-php   │             │
│  │ Node.js   │  │ Nginx    │  │ MySQL 8.0 │  │ PHP 8.2   │             │
│  │ :3000     │  │ :8080    │  │ :3306     │  │ +Apache   │             │
│  └──────────┘  └──────────┘  └──────────┘  │ :8081     │             │
│                                              └──────────┘             │
│                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │cs16-server-  │  │cs16-server-  │  │cs16-server-  │  ... N tane     │
│  │   27015      │  │   27016      │  │   27017      │  game server    │
│  │ ReHLDS/HLDS  │  │ ReHLDS/HLDS  │  │ ReHLDS/HLDS  │  container      │
│  │ 1000 FPS     │  │ 1000 FPS     │  │ 1000 FPS     │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
│                                                                        │
│  Volumes: fastdl-data │ cs-mysql-data │ php-www │ cs16-server-*-cstrike│
│  Network: cs-network (bridge)                                          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Frontend Components

### Public Landing Page (`public/landing.html` + `landing.css`)

| Section | Description |
|---------|-------------|
| **Header** | Logo, nav links (Sunucular / Özellikler / Fiyatlar / Giriş / Üye Ol) |
| **Hero** | "Profesyonel CS 1.6 Sunucu Yönetimi" headline, CTA buttons, live stats (Aktif Sunucu, Online Oyuncu, Maks FPS) |
| **Canlı Sunucu Listesi** | Real-time server table via `GET /api/servers/public` (30s refresh) |
| **Özellikler** | 6 feature cards (File Manager, Plugin Yönetimi, Harita Yönetimi, Live Console, MySQL & PHP, FastDL) |
| **Fiyatlar** | 3 pricing tiers (Deneme/Standart/Pro) with feature comparison table |
| **Footer** | Links, branding |

### Panel SPA (`public/index.html` + `app.js` + `style.css`)

| Screen / Component | Description |
|--------------------|-------------|
| **Login Screen** | Login form + Register form with toggle, validation, error display |
| **Auth Bar** | Logged-in user info, balance display, logout button |
| **Sidebar** | Server list (dynamic, with status indicators), nav buttons (FastDL/MySQL/PHP/Billing/Admin) |
| **Empty State** | Prompt to select or create a server |
| **Rent Panel** | Shown for unowned servers: port, name, plan selection, RCON, map, rent button |
| **Server Dashboard** | Header (name, IP, port, status), Start/Stop/Restart/Delete/Reset buttons, expiry info, stats bar (Players/Map/FPS/CPU) |

**Dashboard Tabs:**

| Tab | Content |
|-----|---------|
| **Console** | WebSocket live log stream, RCON command input |
| **Files** | File browser with breadcrumbs, upload (file/folder), create, edit, download, delete |
| **Plugins** | Plugin list (sortable), upload (.sma/.amxx), .sma → .amxx compiler |
| **Maps** | Mapcycle editor, map upload (.bsp), installed maps list |
| **Players** | Active players table + SQL Leaderboard (Top 100) |
| **Admins & Bans** | Admin list (users.ini) CRUD + Ban list CRUD |
| **FastDL** | Per-server FastDL file browser, sync trigger |
| **Settings** | CVAR config form (20+ parameters) + Quick Config File Editor |

**Infrastructure Pages:**

| Page | Content |
|------|---------|
| **FastDL Server** | Global FastDL status, URL, path |
| **MySQL Server** | DB status, assigned SQL resources per server, databases CRUD, users CRUD, SQL query runner |
| **PHP Server** | PHP status, per-server PHP file manager (upload/edit/create/delete), restart button |
| **Billing & Payments** | IBAN details, payment history, payment reporting with receipt upload |
| **Admin Panel** | User management (list/create/edit/suspend/delete), dynamic settings management |

---

## 3. Backend Components

### Core Server (`server.js`)

| Feature | Implementation |
|---------|---------------|
| **Express App** | CORS (origin whitelist), JSON/URL-encoded parsing, Cookie parsing |
| **JWT Auth** | Custom HMAC-SHA256 JWT tokens (no library), Bearer header / cookie / query token support |
| **WebSocket** | `ws` library, live console stream per container, RCON command execution via WebSocket |
| **Auth Handoff** | Short-lived single-use codes for cross-origin login (landing → panel subdomain) |
| **Expiry Checker** | Hourly background job deletes expired servers, cleans up containers/volumes/DB/FastDL/PHP |

### Database Layer (`panelDb.js`)

| Module | Description |
|--------|-------------|
| **Schema** | Auto-creates: `panel_users`, `panel_servers`, `panel_payments`, `panel_settings`, `panel_auth_handoffs` |
| **Auth** | scrypt password hashing, JWT token creation/verification, user CRUD |
| **Server CRUD** | Container adoption, ownership management, resource provisioning (SQL/DB/PHP/FastDL) |
| **Billing** | Payment reporting, approval/rejection with balance deduction, renewal |
| **Settings** | Dynamic admin-configurable settings (prices, limits, IBAN) |
| **Admin** | User management (create/edit/suspend/delete), SQL account provisioning |

### Game Server Query Engine (`queryHelper.js`)

| Function | Description |
|----------|-------------|
| **A2S_INFO** | UDP-based GoldSrc server query (name, map, players, etc.) |
| **RCON** | Sends RCON commands via UDP and parses responses |
| **Stats extraction** | Parses `stats` command output for FPS/CPU |

### Other Helpers

| File | Description |
|------|-------------|
| `fastdlService.js` | Syncs maps/models/sounds from containers → Nginx serve path |
| `containerFsHelper.js` | File existence check, read/write inside Docker containers |
| `poolService.js` | Maintains 10 always-on CS 1.6 server containers for instant rental |

### Route Modules

| Route File | Endpoints | Description |
|------------|-----------|-------------|
| `routes/servers.js` | `GET /`, `POST /create`, `POST /:id/start\|stop\|restart\|reset\|renew`, `DELETE /:id`, `GET\|POST /:id/settings`, `GET /:id/configs` | Server lifecycle, CVAR configs, config file list |
| `routes/files.js` | `GET /:id/list`, `GET /:id/view`, `POST /:id/edit`, `POST /:id/upload`, `POST /:id/upload-folder`, `DELETE /:id` | File browser & operations inside containers |
| `routes/plugins.js` | `GET /:id`, `POST /:id/upload`, `POST /:id/compile`, `POST /:id/order`, `POST /:id/toggle` | Plugin management + AMXX compiler |
| `routes/maps.js` | `GET /:id`, `POST /:id/upload`, `POST /:id/mapcycle`, `DELETE /:id/:map` | Map upload & mapcycle management |
| `routes/admins.js` | `GET /:id`, `POST /:id/add`, `POST /:id/remove`, `GET /:id/bans`, `POST /:id/ban`, `POST /:id/unban` | Admins (users.ini) & bans |
| `routes/players.js` | `GET /:id` | Active players + SQL leaderboard |
| `routes/fastdl.js` | `GET /status`, `GET /:port/files`, `POST /sync` | FastDL status, file tree, sync trigger |
| `routes/mysql.js` | `GET /status`, `GET /list-dbs`, `GET /list-users`, `GET /list-resources`, `POST /create-db`, `POST /create-user`, `POST /run-query` | MySQL management + query runner |
| `routes/php.js` | `GET /status`, `GET /files`, `GET /files/view`, `POST /files/edit`, `POST /upload`, `POST /new-file`, `POST /new-folder`, `POST /restart` | PHP file manager per server |
| `routes/phpProxy.js` | `GET /proxy?p=<port>` | Public PHP proxy (no auth) |
| `routes/payments.js` | `GET /iban`, `GET /user-payments`, `POST /report`, `GET /admin/payments/pending`, `POST /admin/approve`, `POST /admin/reject` | Payment reporting & admin approval |
| `routes/admin.js` | `GET /users`, `POST /users`, `POST /users/:id/update\|delete\|stop-servers`, `GET /settings`, `POST /settings/create\|update\|delete` | Admin user & settings management |

---

## 4. API Endpoints (Complete Reference)

### Authentication

```
POST   /api/auth/login          { username, password } → { token, user }
POST   /api/auth/register        { username, password } → { token, user }
POST   /api/auth/exchange        { code } → { user }
POST   /api/auth/logout          → { success }
POST   /api/auth/handoff         → { code, expiresIn, redirectUrl }
GET    /api/auth/me              → { user }
```

### Server Management

```
GET    /api/servers                      → Server[] (authenticated)
GET    /api/servers/public               → { servers[] } (no auth)
POST   /api/servers/create               { port?, name, plan, rconPassword, map } → { containerId, port }
POST   /api/servers/:id/start            → { success }
POST   /api/servers/:id/stop             → { success }
POST   /api/servers/:id/restart          → { success }
POST   /api/servers/:id/reset            → { success, containerId }
POST   /api/servers/:id/renew            → { success, expires_at }
DELETE /api/servers/:id                  → { success }
GET    /api/servers/:id/settings         → { settings } (20+ CVARs)
POST   /api/servers/:id/settings         { name, rconPassword, fpsLimit, ... } → { success }
GET    /api/servers/:id/configs          → { configs[] }
```

### File Management

```
GET    /api/files/:id/list?path=         → { files[] }
GET    /api/files/:id/view?file=         → { content }
POST   /api/files/:id/edit              { file, content } → { success }
POST   /api/files/:id/upload            multipart: file + path
POST   /api/files/:id/upload-folder     multipart: files[] + basePath + relativePaths[]
DELETE /api/files/:id?file=             → { success }
```

### Plugins

```
GET    /api/plugins/:id                 → { plugins[], selectedSmaFiles[] }
POST   /api/plugins/:id/upload          multipart: plugin-file + add-to-ini
POST   /api/plugins/:id/compile         { filename, addToIni } → { success, output }
POST   /api/plugins/:id/order           { order: [filename, ...] } → { success }
POST   /api/plugins/:id/toggle          { filename, enabled } → { success }
```

### Maps

```
GET    /api/maps/:id                    → { maps[], mapcycle }
POST   /api/maps/:id/upload             multipart: map-file + add-to-cycle
POST   /api/maps/:id/mapcycle           { content } → { success }
DELETE /api/maps/:id/:map               → { success }
```

### Admins & Bans

```
GET    /api/admins/:id                  → { admins[], bans[] }
POST   /api/admins/:id/add              { auth, password, access, flags, comment } → { success }
POST   /api/admins/:id/remove           { auth } → { success }
POST   /api/admins/:id/ban              { target, duration, isIp } → { success }
POST   /api/admins/:id/unban            { target } → { success }
```

### Players & Stats

```
GET    /api/players/:id                 → { players[], leaderboard, dbInfo }
```

### FastDL

```
GET    /api/fastdl/status               → { status, url, path }
GET    /api/fastdl/:port/files          → { files[] }
POST   /api/fastdl/sync                 { port } → { totalCopied, totalErrors }
```

### MySQL

```
GET    /api/mysql/status                → { status, version, host, databases[], users[], resources[] }
POST   /api/mysql/create-db             { name } → { success }
POST   /api/mysql/create-user           { username, password, database, grants } → { success }
POST   /api/mysql/run-query             { db, query, offset? } → { columns[], rows[], total }
```

### PHP

```
GET    /api/php/status                  → { status, roots[] }
GET    /api/php/files?path=             → { files[] }
GET    /api/php/files/view?file=        → { content }
POST   /api/php/files/edit              { file, content } → { success }
POST   /api/php/upload                  multipart: files[] + path
POST   /api/php/new-file                { path, name } → { success }
POST   /api/php/new-folder              { path, name } → { success }
POST   /api/php/restart                 → { success }

GET    /api/php/proxy                   Public proxy (no auth)
```

### Billing & Payments

```
GET    /api/payments/iban               → { iban }
GET    /api/payments/user-payments      → Payment[]
POST   /api/payments/report             multipart: amount + sender_name + receipt?
GET    /api/admin/payments/pending      → Payment[] (admin)
POST   /api/admin/payments/approve      { paymentId } → { success } (admin)
POST   /api/admin/payments/reject       { paymentId } → { success } (admin)
```

### Admin

```
GET    /api/admin/users                 → { users[] }
POST   /api/admin/users                 { username, password, role, balance } → { user }
POST   /api/admin/users/:id/update      { role?, balance?, suspended? } → { success }
POST   /api/admin/users/:id/delete      → { success }
POST   /api/admin/users/:id/stop-servers → { success }
GET    /api/admin/settings              → { settings[] }
POST   /api/admin/settings/create       { key, value, name, type, description, options } → { success }
POST   /api/admin/settings/update       { key, value?, name?, type?, ... } → { success }
POST   /api/admin/settings/delete       { key } → { success }
```

---

## 5. Database Schema

### `panel_users`

| Column | Type | Notes |
|--------|------|-------|
| id | INT AUTO_INCREMENT | PK |
| username | VARCHAR(64) | UNIQUE, NOT NULL |
| password_hash | VARCHAR(255) | scrypt format |
| role | ENUM('admin','user') | |
| balance | DECIMAL(10,2) | Default 0.00 |
| suspended | TINYINT(1) | Default 0 |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | ON UPDATE CURRENT_TIMESTAMP |

### `panel_servers`

| Column | Type | Notes |
|--------|------|-------|
| id | INT AUTO_INCREMENT | PK |
| container_id | VARCHAR(128) | UNIQUE, Docker container ID |
| port | INT | UNIQUE |
| owner_id | INT | FK → panel_users.id |
| name | VARCHAR(255) | |
| plan_type | ENUM('free','standard','pro') | |
| expires_at | TIMESTAMP | |
| db_name | VARCHAR(64) | Per-server MySQL database |
| db_username | VARCHAR(64) | Per-server MySQL user |
| db_password | VARCHAR(255) | |
| php_path | VARCHAR(255) | |
| php_url | VARCHAR(512) | |
| fastdl_path | VARCHAR(255) | |
| sv_downloadurl | VARCHAR(512) | |
| suspended | TINYINT(1) | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### `panel_payments`

| Column | Type | Notes |
|--------|------|-------|
| id | INT AUTO_INCREMENT | PK |
| user_id | INT | FK → panel_users.id |
| amount | DECIMAL(10,2) | |
| sender_name | VARCHAR(128) | |
| receipt_path | VARCHAR(512) | Uploaded receipt file |
| status | ENUM('pending','approved','rejected') | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### `panel_settings`

| Column | Type | Notes |
|--------|------|-------|
| key | VARCHAR(64) | PK |
| value | TEXT | |
| name | VARCHAR(255) | Display name |
| type | VARCHAR(50) | 'text','number','textarea','select' |
| description | TEXT | |
| options | TEXT | JSON array for 'select' type |

### `panel_auth_handoffs`

| Column | Type | Notes |
|--------|------|-------|
| id | BIGINT UNSIGNED AUTO_INCREMENT | PK |
| code_hash | CHAR(64) | SHA-256 of handoff code |
| user_id | INT | FK → panel_users.id |
| created_at | DATETIME(3) | |
| expires_at | DATETIME(3) | 60 second TTL |
| used_at | DATETIME(3) | NULL until consumed |

---

## 6. Docker Infrastructure

### Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `cs-panel` | Custom (panel.Dockerfile) | `3000` | Node.js management panel |
| `cs-fastdl` | nginx:alpine | `8080` | Serves map/model/sound downloads |
| `cs-mysql` | mysql:8.0 | `3306` | Panel DB + per-server databases |
| `cs-php` | Custom (php.Dockerfile) | `8081` | Per-server PHP hosting |
| `cs16-server-*` | cs16-server-base | dynamic | Game server containers |

### Volumes

| Volume | Mount Point | Purpose |
|--------|-------------|---------|
| `fastdl-data` | `/fastdl-data` (panel) / `/var/www/fastdl` (nginx) | Shared FastDL assets |
| `cs-mysql-data` | `/var/lib/mysql` | MySQL data persistence |
| `php-www` | `/php-www` (panel) / `/var/www/html` (php) | Shared PHP files |
| `cs16-server-*-cstrike` | `/hlds/cstrike` | Per-server game files |

### Network

Single bridge network `cs-network` connects all services. Game server containers also join this network for internal communication (MySQL, FastDL).

---

## 7. Key Flows

### Authentication Flow

```
1. User visits panel.example.com (or login form on same origin)
2. POST /api/auth/login { username, password }
3. Server verifies credentials (scrypt), returns JWT token + user object
4. Frontend stores token, attaches as Bearer header to all /api requests
5. Server-side middleware (requireApiAuth) verifies token on every request
6. Token expires after configured TTL (default 24 hours)

Cross-Origin Handoff (landing → panel):
1. Landing page creates handoff code via POST /api/auth/handoff
2. Redirects to panel.example.com/auth/callback#code=xxx
3. Frontend reads hash, exchanges code via POST /api/auth/exchange
4. Server returns user + sets httpOnly session cookie
```

### Server Rental Flow

```
1. Admin pre-creates 10 containers in pool (owner_id = 1)
2. User sees available (unrented) servers with "Rent" badge in sidebar
3. User clicks server → Rent Panel shown with config form
4. User fills: name, plan (Standard/Pro), RCON password, start map
5. POST /api/servers/create → deducts balance, assigns ownership
6. Container is recreated with fresh volume, user's env vars
7. MySQL database + user provisioned, PHP area created
8. FastDL synced, server.cfg updated with sv_downloadurl
9. Container starts → server ready in 30-60 seconds
```

### Server Lifecycle

```
CREATED → RUNNING (online) → STOPPED → RUNNING ... → EXPIRED → DELETED

Expiry check runs every hour:
1. Finds servers WHERE expires_at <= NOW()
2. Stops container, removes container + volume
3. Drops MySQL database + user
4. Deletes FastDL files + PHP data
5. Removes database record
6. Pool service recreates a fresh replacement container
```

### Payment Flow

```
1. User sends money to IBAN (manually via bank transfer)
2. User goes to Billing tab, fills amount + sender name + uploads receipt
3. POST /api/payments/report → creates pending payment
4. Admin sees payment in Admin Panel → verifies with bank records
5. Admin approves: POST /api/admin/payments/approve → balance increases
6. OR Admin rejects: POST /api/admin/payments/reject
```

---

## 8. Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla JavaScript SPA, HTML5, CSS3 |
| **Backend** | Node.js, Express 4, ws (WebSocket) |
| **Database** | MySQL 8.0 (via mysql2/promise) |
| **Auth** | Custom JWT (HMAC-SHA256), scrypt password hashing |
| **Containers** | Docker (dockerode), Docker Compose |
| **Game Engine** | ReHLDS (CS 1.6) on Debian 12 |
| **File Serving** | Nginx (FastDL) |
| **PHP Hosting** | PHP 8.2 + Apache + mysqli/pdo_mysql |
| **File Upload** | multer (memory + disk storage) |
| **UDP Queries** | Native dgram module for GoldSrc A2S_INFO |
| **Asset Delivery** | SteamCMD via custom Docker images |
