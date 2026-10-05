# CS 1.6 Server Management Panel

A Docker-based management panel for Counter-Strike 1.6 game servers. Create, manage, and monitor CS 1.6 server instances with ease.

## Features

- **Membership** — Self sign-up (username + e-mail + terms), password strength rules, login by username or e-mail, account lockout and rate limiting, single-use password-reset links, "log out of all devices", notifications.
- **Billing & paywall** — Balance ledger (every credit/debit is recorded), bank-transfer deposits with reference codes and receipt review, admin-defined plans (price, slots, FPS, features), 1/3/6/12-month periods with discounts, coupons, trial plan, auto-renew, expiry reminders (7/3/1 days), automatic suspension (HTTP 402 paywall) and reclamation after a grace period.
- **Admin tools** — Dashboard with revenue/server metrics, user management (balance adjust, suspend, reset link, force logout, delete), server operations (extend, suspend, transfer, change plan, release, bulk actions), payment review, plans & coupons, announcements, infrastructure health/restart, maintenance mode, settings and a full audit log.
- **Server Management** — Start/stop/restart (containers are recreated automatically if missing), reset, live console over WebSocket, logs and crash logs, validated `server.cfg` settings.
- **File Manager** — Upload with progress, folders, drag & drop, ZIP extraction, rename, mkdir, streamed downloads, in-browser editor.
- **FastDL** — Automatic sync of client assets; config files (`*.cfg`, `*.ini`) are never published.
- **MySQL** — One database + user per server, password rotation, schema browser, query console scoped to the server's own database, SQL export. Credentials are written to `addons/amxmodx/configs/sql.cfg` and the website config automatically.
- **PHP websites** — Each server gets an isolated site (`open_basedir`, separate sessions/tmp, disabled dangerous functions, panel cookie stripped). Ready-made community template (live server status, players, settings page), blank template, ZIP upload, custom domains.
- **Admin Panel / Landing** — Fully rewritten responsive UI (vanilla ES modules, no `innerHTML`).

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Docker Host                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  cs-panel │  │ cs-fastdl│  │     cs-mysql     │   │
│  │  (Node.js)│  │ (Nginx)  │  │    (MySQL 8.0)   │   │
│  └─────┬─────┘  └──────────┘  └──────────────────┘   │
│        │                                              │
│  ┌─────┴─────────────────────────────────────────┐   │
│  │         CS 1.6 Game Server Containers          │   │
│  │  cs16-server-27015  cs16-server-27016  ...     │   │
│  └────────────────────────────────────────────────┘   │
│  ┌──────────┐                                        │
│  │  cs-php  │  ┌─────────────┐                       │
│  │ (Apache) │  │ cs-bhop-web │                       │
│  └──────────┘  └─────────────┘                       │
└─────────────────────────────────────────────────────┘
```

## Prerequisites

- Docker Engine 24+ with Docker Compose plugin
- Git
- A server with a public IP (for game server connectivity)

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/YOUR_USERNAME/cs16-panel.git
cd cs16-panel
cp .env.example .env
```

Edit `.env` with your settings (at minimum set `HOST_IP`, `PANEL_AUTH_SECRET`, and `MYSQL_ROOT_PASSWORD`).

### 2. Start the Stack

```bash
docker compose up -d --build
```

This starts: `cs-panel`, `cs-fastdl`, `cs-mysql`, `cs-php`, and `cs-bhop-web`.

### 3. Access the Panel

Open `http://localhost:3000` in your browser.

Default logins (you will be asked to change the password on first login):
- Admin: `admin` / `admin123` (or `PANEL_ADMIN_PASSWORD`)
- User: `user` / `user123` (or `PANEL_USER_PASSWORD`)

### 4. Create a Game Server

Once the panel is running, use the web UI or API to provision CS 1.6 server instances. Each server runs in its own Docker container with isolated volumes.

## Local Development

Use the local override to avoid port conflicts:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

| Service | Default URL |
|---------|------------|
| Panel | `http://localhost:3100` |
| FastDL | `http://localhost:18080` |
| PHP | `http://localhost:18081` |
| Bhop Web | `http://localhost:18082` |
| MySQL | `localhost:3307` |

### Running Tests

```bash
npm test
npm run check
npm run test:integration
```

## Project Structure

```
cs16-panel/
├── server.js              # Express app, security headers, WebSocket console, lifecycle timer
├── config.js              # Single source of public URLs / hosts (FastDL, PHP, MySQL)
├── panelDb.js             # Schema + versioned migrations, users, ledger, plans, coupons, audit
├── security.js            # Cookies, origin (CSRF) checks, rate limiting, CSP
├── billingService.js      # Quotes, rentals, renewals, plan changes
├── lifecycleService.js    # Reminders, auto-renew, suspension, reclamation
├── poolService.js         # Rental pool maintenance (setting: pool_ports)
├── gameContainer.js       # Game container creation/recreation
├── phpSiteService.js      # Per-server PHP sites, templates, domains
├── fastdlService.js       # FastDL sync
├── zipReader.js           # Safe ZIP parsing (no traversal / zip bombs)
├── containerFsHelper.js   # Container filesystem helpers
├── routes/                # auth, account, servers, files, plugins, maps, players,
│                          # admins, fastdl, mysql, sites, php, payments, admin
├── public/                # index.html, css/app.css, js/{core,main}.js, js/views/*, landing.*
├── php/                   # Apache vhost, php.ini, prepend, entrypoint for cs-php
├── php-templates/         # Website templates (community, blank)
├── nginx-fastdl/          # FastDL nginx config
├── scripts/check.js       # Syntax check for every JS file (npm run check)
└── tests/                 # node:test suites + mock Docker (PANEL_MOCK_DOCKER=1)
```

## Production Deployment

1. Set up a server with Docker and a domain (e.g., `panel.example.com`)
2. Configure Nginx reverse proxy with SSL (see `nginx-panel.conf` for reference)
3. Set `NODE_ENV=production` and strong passwords in `.env`
4. Start the stack with `docker compose up -d`
5. Configure Cloudflare or your DNS provider

## Security Notes

- `MYSQL_ROOT_PASSWORD` is required; MySQL is bound to `127.0.0.1` unless `MYSQL_BIND_HOST` is changed.
- If `PANEL_AUTH_SECRET` is empty, a random secret is generated and stored in the database.
- Seeded `admin`/`user` accounts are never overwritten on restart; default passwords force a password change.
- Session cookie is host-only and `HttpOnly`; state-changing requests must come from the panel origin.
- Sessions are revoked on password change / "log out everywhere" (token versioning).
- Ports listed in `PROTECTED_SERVER_PORTS` cannot be reset or deleted.

## Upgrading from the previous version (TR)

1. `.env` dosyasında `MYSQL_ROOT_PASSWORD` tanımlı olmalı (artık zorunlu).
2. İmajları yeniden derleyin: `docker compose build cs-panel cs-php` ve oyun imajı (entrypoint değişti).
3. Panel ilk açılışta veritabanını otomatik taşır (migration); eski fiyat ayarları paketlere dönüştürülür.
4. Web siteleri için `PHP_PUBLIC_BASE_URL` ayarlayın. Özel alan adı kullanılacaksa alan adının A kaydı PHP sunucusunu göstermelidir; `{port}` içeren bir adres (`http://php-{port}.example.com`) wildcard DNS ile alt alan adı kullanır.
5. FastDL adresi `FASTDL_PUBLIC_URL` ile belirlenir; kiralama havuzu portları Yönetim → Ayarlar → `pool_ports` ile değiştirilir.

## License

MIT
