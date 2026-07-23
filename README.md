# CS 1.6 Server Management Panel

A Docker-based management panel for Counter-Strike 1.6 game servers. Create, manage, and monitor CS 1.6 server instances with ease.

## Features

- **Server Management** — Create, start, stop, and delete CS 1.6 server containers
- **File Manager** — Upload and manage server files (maps, plugins, configs)
- **Plugin System** — AMX Mod X plugin compilation and management
- **FastDL** — Automatic Fast Download file hosting for maps/models/sounds
- **MySQL** — Per-server MySQL database provisioning
- **PHP Support** — Per-server PHP hosting area
- **Real-time Console** — Live server console via WebSocket with RCON support
- **Server Pool** — Auto-maintained pool of ready-to-use server instances
- **Payment Integration** — Rental/extension billing support (İyzico)
- **Admin Panel** — User management, server oversight, system settings

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

Default logins (change in production):
- Admin: `admin` / `admin123`
- User: `user` / `user123`

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
├── server.js                 # Main Express application
├── panelDb.js                # Database layer (MySQL + auth tokens)
├── serverProtection.js       # Protected port management
├── containerFsHelper.js      # Docker container filesystem utilities
├── fastdlService.js          # FastDL file sync service
├── poolService.js            # Server pool auto-maintenance
├── queryHelper.js            # CS 1.6 server query (A2S, RCON)
├── docker-compose.yml        # Production Docker stack
├── docker-compose.local.yml  # Local development overrides
├── panel.Dockerfile          # Panel image build
├── php.Dockerfile            # PHP/Apache image build
├── frontend.Dockerfile       # Next.js frontend build
├── bhop-web.Dockerfile       # Bhop website image build
├── Dockerfile                # Legacy panel build
├── .env.example              # Environment variable template
│
├── routes/                   # Express API routes
│   ├── servers.js            # Server CRUD & lifecycle
│   ├── files.js              # File upload/manager
│   ├── plugins.js            # AMX plugin management
│   ├── maps.js               # Map upload & listing
│   ├── admins.js             # Server admin management
│   ├── players.js            # Player management
│   ├── fastdl.js             # FastDL file hosting
│   ├── mysql.js              # MySQL account provisioning
│   ├── php.js                # PHP hosting management
│   ├── phpProxy.js           # Public PHP proxy
│   ├── payments.js           # Payment/rental integration
│   ├── admin.js              # Admin oversight routes
│   └── payments.js           # İyzico payment processing
│
├── public/                   # Frontend assets (vanilla JS SPA)
│   ├── index.html            # Login & panel entry
│   ├── landing.html          # Public landing page
│   ├── app.js                # Panel SPA logic
│   ├── style.css             # Main styles
│   └── assets/               # Images & graphics
│
├── nginx-fastdl/             # FastDL Nginx configuration
├── scripts/                  # Deployment & maintenance
│   └── live_safe_ops.py      # Safe production operations
├── tests/                    # Test suite
├── files/                    # CS 1.6 base game files (HLDS)
└── servers/                  # Per-server data volumes
```

## Production Deployment

1. Set up a server with Docker and a domain (e.g., `panel.example.com`)
2. Configure Nginx reverse proxy with SSL (see `nginx-panel.conf` for reference)
3. Set `NODE_ENV=production` and strong passwords in `.env`
4. Start the stack with `docker compose up -d`
5. Configure Cloudflare or your DNS provider

## Security Notes

- Change all default passwords in `.env` before going to production
- The `.env` file is excluded from version control via `.gitignore`
- Ports 27015 and 27016 are protected by default against accidental deletion
- API authentication uses JWT-like tokens with configurable TTL
- CORS is restricted to configured panel origins in production
- Sensitive operations (delete, reset) are blocked for protected ports

## License

MIT
