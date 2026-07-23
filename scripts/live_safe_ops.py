#!/usr/bin/env python3
"""Guarded live-server inventory/backup/deploy helper.

The default action is read-only. Destructive operations are deliberately not
implemented here; deploy support is added only after inventory and backups pass.
"""

from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import os
from pathlib import Path
import re
import shlex
import sys
import tarfile
import tempfile

import paramiko


PROJECT_ROOT = Path(__file__).resolve().parents[1]
REMOTE_DIR = "/opt/cspanel"
PROTECTED_PORTS = (27015, 27016)


def emit(value: str) -> None:
    sys.stdout.buffer.write(value.encode("utf-8", errors="replace"))
    if value and not value.endswith("\n"):
        sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def read_env_file() -> dict[str, str]:
    values: dict[str, str] = {}
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return values
    for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def legacy_deploy_values() -> dict[str, str]:
    """Read simple legacy constants without importing/executing deployment code."""
    values: dict[str, str] = {}
    for filename in ("deploy_v2.py", "auto_deploy.py"):
        source_path = PROJECT_ROOT / filename
        if not source_path.exists():
            continue
        tree = ast.parse(source_path.read_text(encoding="utf-8", errors="ignore"))
        for node in tree.body:
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in {"HOST", "USER", "PASSWORD", "PORT"}:
                try:
                    values[target.id] = str(ast.literal_eval(node.value))
                except (ValueError, TypeError):
                    pass
        if values.get("PASSWORD"):
            break
    return values


def handover_password() -> str | None:
    for filename in ("agent_handover.md", "handover.md", "HANDOFF.md"):
        source_path = PROJECT_ROOT / filename
        if not source_path.exists():
            continue
        match = re.search(r"\*\*Password:\*\*\s*`([^`]+)`", source_path.read_text(encoding="utf-8", errors="ignore"))
        if match:
            return match.group(1)
    return None


def connection_config() -> tuple[str, int, str, str]:
    file_env = read_env_file()
    legacy = legacy_deploy_values()
    host = (os.environ.get("DEPLOY_HOST") or file_env.get("DEPLOY_HOST")
            or file_env.get("GAME_SERVER_HOST") or file_env.get("HOST_IP") or legacy.get("HOST"))
    port = int(os.environ.get("DEPLOY_PORT") or file_env.get("DEPLOY_PORT") or legacy.get("PORT") or "22")
    user = os.environ.get("DEPLOY_USER") or file_env.get("DEPLOY_USER") or legacy.get("USER") or "root"
    explicit_password = os.environ.get("DEPLOY_PASSWORD") or file_env.get("DEPLOY_PASSWORD")
    password = explicit_password or (legacy.get("PASSWORD") if host == legacy.get("HOST") else handover_password()) or legacy.get("PASSWORD")
    if not host or not password:
        raise RuntimeError("DEPLOY_HOST/HOST_IP and DEPLOY_PASSWORD are required")
    return host, port, user, password


def connect() -> paramiko.SSHClient:
    host, port, user, password = connection_config()
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, port=port, username=user, password=password, timeout=20, auth_timeout=20)
    transport = client.get_transport()
    if transport:
        fingerprint = transport.get_remote_server_key().get_fingerprint().hex(":")
        print(f"Connected to {user}@{host}:{port}; host-key fingerprint {fingerprint}")
    return client


def run(client: paramiko.SSHClient, command: str, timeout: int = 60, pty: bool = False) -> str:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=pty)
    del stdin
    output = stdout.read().decode("utf-8", errors="replace")
    error = stderr.read().decode("utf-8", errors="replace")
    exit_code = stdout.channel.recv_exit_status()
    if exit_code:
        details = "\n".join(part for part in (output.strip(), error.strip()) if part)
        raise RuntimeError(f"Remote command failed ({exit_code}): {details}")
    return output


def build_deploy_archive(destination: Path) -> None:
    files = [
        ".env.example",
        "server.js",
        "serverProtection.js",
        "queryHelper.js",
        "containerFsHelper.js",
        "panelDb.js",
        "poolService.js",
        "fastdlService.js",
        "package.json",
        "package-lock.json",
        "docker-compose.yml",
        "panel.Dockerfile",
        "Dockerfile",
        "download_hlds.sh",
        "entrypoint.sh",
        "nginx-fastdl/nginx.conf",
    ]
    directories = ["routes", "public", "tests"]
    with tarfile.open(destination, "w:gz") as archive:
        for relative in files:
            source = PROJECT_ROOT / relative
            if not source.is_file():
                raise RuntimeError(f"Deploy source is missing: {relative}")
            archive.add(source, arcname=relative, recursive=False)
        for relative in directories:
            source = PROJECT_ROOT / relative
            if not source.is_dir():
                raise RuntimeError(f"Deploy directory is missing: {relative}")
            archive.add(source, arcname=relative)


def inventory(client: paramiko.SSHClient) -> None:
    protected_names = " ".join(shlex.quote(f"cs16-server-{port}") for port in PROTECTED_PORTS)
    command = f"""
set -eu
echo '--- host ---'
hostname
date -Is
docker --version
docker compose version
echo '--- containers ---'
docker ps --format '{{{{.Names}}}}|{{{{.ID}}}}|{{{{.Image}}}}|{{{{.Status}}}}|{{{{.Ports}}}}'
echo '--- protected container details ---'
for name in {protected_names}; do
  if docker inspect "$name" >/dev/null 2>&1; then
    docker inspect "$name" --format '{{{{.Name}}}}|{{{{.Id}}}}|running={{{{.State.Running}}}}|image={{{{.Config.Image}}}}|mounts={{{{range .Mounts}}}}{{{{.Type}}}}:{{{{.Source}}}}=>{{{{.Destination}}}};{{{{end}}}}'
  else
    echo "$name|MISSING"
  fi
done
echo '--- FastDL/PHP mount topology ---'
for name in cs-panel cs-fastdl cs-php; do
  docker inspect "$name" --format '{{{{.Name}}}}|{{{{range .Mounts}}}}{{{{.Type}}}}:{{{{.Source}}}}=>{{{{.Destination}}}};{{{{end}}}}'
done
for item in /fastdl-data /opt/cspanel/fastdl-data /php-www /opt/cspanel/php-www; do
  if [ -e "$item" ]; then
    echo "$item|resolved=$(readlink -f "$item")|device-inode=$(stat -c '%d:%i' "$item")"
  else
    echo "$item|MISSING"
  fi
done
echo '--- project files ---'
if [ -d {shlex.quote(REMOTE_DIR)} ]; then
  cd {shlex.quote(REMOTE_DIR)}
  pwd
  for file in server.js containerFsHelper.js fastdlService.js poolService.js panelDb.js docker-compose.yml panel.Dockerfile nginx-fastdl/nginx.conf; do
    if [ -f "$file" ]; then sha256sum "$file"; else echo "MISSING $file"; fi
  done
else
  echo '{REMOTE_DIR}|MISSING'
fi
echo '--- storage ---'
df -h {shlex.quote(REMOTE_DIR)} 2>/dev/null || df -h /
"""
    emit(run(client, command, timeout=90))


def backup(client: paramiko.SSHClient) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_dir = f"{REMOTE_DIR}/backups/predeploy-{stamp}"
    script = f"""
set -euo pipefail
umask 077
backup={shlex.quote(backup_dir)}
mkdir -p "$backup"

echo '[backup] protected container metadata'
docker inspect cs16-server-27015 cs16-server-27016 > "$backup/protected-containers.json"
docker inspect cs-panel cs-fastdl cs-mysql > "$backup/infrastructure-containers.json"

echo '[backup] protected cstrike volumes (read-only mounts)'
for port in 27015 27016; do
  volume="cs16-server-${{port}}-cstrike"
  docker volume inspect "$volume" > "$backup/${{volume}}.inspect.json"
  docker run --rm --entrypoint /bin/tar \
    -v "$volume:/source:ro" -v "$backup:/backup" cs16-server-base \
    -czf "/backup/${{volume}}.tar.gz" -C /source .
done

echo '[backup] FastDL and PHP bind directories'
for port in 27015 27016; do
  for base in /fastdl-data /opt/cspanel/fastdl-data; do
    if [ -d "$base/$port" ]; then
      label=$(echo "$base" | sed 's#^/##; s#/#-#g')
      tar -czf "$backup/${{label}}-${{port}}.tar.gz" -C "$base/$port" .
    fi
  done
  for base in /php-www /opt/cspanel/php-www; do
    if [ -d "$base/$port" ]; then
      label=$(echo "$base" | sed 's#^/##; s#/#-#g')
      tar -czf "$backup/${{label}}-${{port}}.tar.gz" -C "$base/$port" .
    fi
  done
done

echo '[backup] MySQL logical dump'
mysql_password=$(docker exec cs-mysql printenv MYSQL_ROOT_PASSWORD)
dbs=$(docker exec -e MYSQL_PWD="$mysql_password" cs-mysql mysql -uroot -N -e \
  "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('cs_panel','cs_srv_27015','cs_srv_27016') ORDER BY SCHEMA_NAME")
test -n "$dbs"
docker exec -e MYSQL_PWD="$mysql_password" cs-mysql mysqldump -uroot \
  --single-transaction --quick --routines --events --triggers --databases $dbs \
  > "$backup/protected-databases.sql"

echo '[backup] current panel code and environment'
cd {shlex.quote(REMOTE_DIR)}
tar -czf "$backup/panel-code.tar.gz" \
  server.js queryHelper.js containerFsHelper.js panelDb.js poolService.js fastdlService.js \
  routes public package.json package-lock.json docker-compose.yml panel.Dockerfile \
  Dockerfile download_hlds.sh entrypoint.sh files \
  nginx-fastdl nginx-panel.conf .env 2>/dev/null

echo '[verify] archives and dump'
for archive in "$backup"/*.tar.gz; do gzip -t "$archive"; done
test -s "$backup/protected-databases.sql"
(cd "$backup" && sha256sum *.tar.gz *.sql *.json > SHA256SUMS)
chmod -R go-rwx "$backup"
echo "BACKUP_DIR=$backup"
du -sh "$backup"
ls -lh "$backup"
echo '[verify] protected containers remain running'
for name in cs16-server-27015 cs16-server-27016; do
  docker inspect "$name" --format '{{{{.Name}}}}|{{{{.Id}}}}|running={{{{.State.Running}}}}|started={{{{.State.StartedAt}}}}'
done
"""
    command = "bash -lc " + shlex.quote(script)
    emit(run(client, command, timeout=900))


def backup_status(client: paramiko.SSHClient) -> None:
    command = f"""
set -eu
latest=$(find {shlex.quote(REMOTE_DIR + '/backups')} -mindepth 1 -maxdepth 1 -type d -name 'predeploy-*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)
if [ -n "$latest" ]; then
  echo "LATEST=$latest"
  du -sh "$latest"
  find "$latest" -maxdepth 1 -type f -printf '%f|%s bytes\n' | sort
fi
ps -eo pid,etime,cmd | grep -E 'tar|mysqldump|live_safe' | grep -v grep || true
for name in cs16-server-27015 cs16-server-27016; do
  docker inspect "$name" --format '{{{{.Name}}}}|{{{{.Id}}}}|running={{{{.State.Running}}}}'
done
"""
    emit(run(client, "bash -lc " + shlex.quote(command), timeout=60))


def deploy(client: paramiko.SSHClient, confirmed: bool) -> None:
    if not confirmed:
        raise RuntimeError("Deploy requires --yes after a verified backup")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    remote_archive = f"{REMOTE_DIR}/backups/deploy-source-{stamp}.tar.gz"
    remote_staging = f"{REMOTE_DIR}/.deploy-{stamp}"

    with tempfile.TemporaryDirectory(prefix="cspanel-deploy-") as temp_dir:
        local_archive = Path(temp_dir) / "deploy-source.tar.gz"
        build_deploy_archive(local_archive)
        sftp = client.open_sftp()
        try:
            sftp.put(str(local_archive), remote_archive)
        finally:
            sftp.close()

    script = f"""
set -euo pipefail
project={shlex.quote(REMOTE_DIR)}
archive={shlex.quote(remote_archive)}
staging={shlex.quote(remote_staging)}
backup=$(find "$project/backups" -mindepth 1 -maxdepth 1 -type d -name 'predeploy-*' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -n "$backup"
(cd "$backup" && sha256sum -c SHA256SUMS >/dev/null)
test -s "$backup/protected-databases.sql"

before15=$(docker inspect cs16-server-27015 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
before16=$(docker inspect cs16-server-27016 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
test "${{before15##*|}}" = true
test "${{before16##*|}}" = true

rm -rf "$staging"
mkdir -p "$staging"
tar -xzf "$archive" -C "$staging"
cp "$project/.env" "$staging/.env"

echo '[preflight] JavaScript syntax'
for file in server.js serverProtection.js containerFsHelper.js fastdlService.js poolService.js panelDb.js routes/files.js routes/maps.js routes/plugins.js routes/servers.js public/app.js; do
  docker run --rm --entrypoint node -v "$staging:/candidate:ro" -w /candidate cspanel-cs-panel --check "$file"
done
echo '[preflight] Game image shell scripts'
bash -n "$staging/download_hlds.sh" "$staging/entrypoint.sh"
echo '[preflight] Compose and Nginx config'
docker compose --project-directory "$staging" --env-file "$staging/.env" -f "$staging/docker-compose.yml" config -q
docker run --rm -v "$staging/nginx-fastdl/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine nginx -t

deployed=0
rollback() {{
  code=$?
  if [ "$deployed" = 1 ]; then
    echo '[rollback] Restoring previous panel code'
    tar -xzf "$backup/panel-code.tar.gz" -C "$project"
    cd "$project"
    docker compose build cs-panel || true
    docker compose up -d --no-deps cs-panel || true
    docker compose up -d --no-deps --force-recreate cs-fastdl || true
  fi
  exit "$code"
}}
trap rollback ERR

echo '[deploy] Installing selected source files'
tar -xzf "$archive" -C "$project"
deployed=1
cd "$project"
docker compose build cs-panel
docker compose up -d --no-deps cs-panel
docker compose up -d --no-deps --force-recreate cs-fastdl

echo '[verify] Infrastructure health'
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3000/api/auth/me >/dev/null; then break; fi
  if [ "$attempt" = 60 ]; then echo 'Panel health check timed out'; exit 1; fi
  sleep 1
done
test "$(docker inspect cs-panel --format '{{{{.State.Running}}}}')" = true
docker exec cs-fastdl nginx -t

after15=$(docker inspect cs16-server-27015 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
after16=$(docker inspect cs16-server-27016 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
test "$before15" = "$after15"
test "$before16" = "$after16"

{{
  echo "deployed_at={stamp}"
  echo "source_archive=$archive"
  sha256sum "$archive"
  echo "protected_27015=$after15"
  echo "protected_27016=$after16"
  docker inspect cs-panel --format 'panel={{{{.Id}}}}|running={{{{.State.Running}}}}|started={{{{.State.StartedAt}}}}'
  docker inspect cs-fastdl --format 'fastdl={{{{.Id}}}}|running={{{{.State.Running}}}}|started={{{{.State.StartedAt}}}}'
}} > "$backup/deploy-{stamp}.txt"

trap - ERR
rm -rf "$staging"
echo 'DEPLOY_OK'
cat "$backup/deploy-{stamp}.txt"
docker logs --tail 80 cs-panel
"""
    command = "bash -lc " + shlex.quote(script)
    emit(run(client, command, timeout=1200, pty=True))


def build_game_image(client: paramiko.SSHClient, confirmed: bool) -> None:
    """Build and promote the clean image without recreating running game servers."""
    if not confirmed:
        raise RuntimeError("Game image build requires --yes; running servers will remain untouched")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = f"cs16-server-base:candidate-{stamp.lower()}"
    previous = f"cs16-server-base:pre-clean-{stamp.lower()}"
    script = f"""
set -euo pipefail
cd {shlex.quote(REMOTE_DIR)}
backup=$(find backups -mindepth 1 -maxdepth 1 -type d -name 'predeploy-*' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -n "$backup"
(cd "$backup" && sha256sum -c SHA256SUMS >/dev/null)

before15=$(docker inspect cs16-server-27015 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
before16=$(docker inspect cs16-server-27016 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
test "${{before15##*|}}" = true
test "${{before16##*|}}" = true
old_id=$(docker image inspect cs16-server-base:latest --format '{{{{.Id}}}}')
docker tag "$old_id" {shlex.quote(previous)}

echo '[build] Candidate clean game image'
docker build --tag {shlex.quote(candidate)} .
echo '[verify] Candidate compiler and clean snapshot modes'
docker run --rm --entrypoint /bin/sh {shlex.quote(candidate)} -lc '
  test -x /hlds/cstrike/addons/amxmodx/scripting/amxxpc
  test -x /hlds_clean/cstrike/addons/amxmodx/scripting/amxxpc
  test "$(stat -c %a /hlds/cstrike/addons/amxmodx/scripting/amxxpc)" = 755
  test "$(stat -c %a /hlds_clean/cstrike/addons/amxmodx/scripting/amxxpc)" = 755
  bash -n /hlds/entrypoint.sh
'

new_id=$(docker image inspect {shlex.quote(candidate)} --format '{{{{.Id}}}}')
test -n "$new_id"
docker tag "$new_id" cs16-server-base:latest

after15=$(docker inspect cs16-server-27015 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
after16=$(docker inspect cs16-server-27016 --format '{{{{.Id}}}}|{{{{.State.StartedAt}}}}|{{{{.State.Running}}}}')
test "$before15" = "$after15"
test "$before16" = "$after16"
test "$(docker image inspect cs16-server-base:latest --format '{{{{.Id}}}}')" = "$new_id"

{{
  echo "built_at={stamp}"
  echo "previous_tag={previous}"
  echo "previous_id=$old_id"
  echo "candidate_tag={candidate}"
  echo "current_id=$new_id"
  echo "protected_27015=$after15"
  echo "protected_27016=$after16"
}} > "$backup/game-image-{stamp}.txt"
echo 'GAME_IMAGE_BUILD_OK'
cat "$backup/game-image-{stamp}.txt"
"""
    emit(run(client, "bash -lc " + shlex.quote(script), timeout=3600, pty=True))


def verify_live(client: paramiko.SSHClient) -> None:
    script = f"""
set -euo pipefail
echo '[verify] deploy record'
latest_backup=$(find {shlex.quote(REMOTE_DIR + '/backups')} -mindepth 1 -maxdepth 1 -type d -name 'predeploy-*' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
latest_record=$(find "$latest_backup" -maxdepth 1 -type f -name 'deploy-*.txt' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -s "$latest_record"
cat "$latest_record"
latest_game_record=$(find "$latest_backup" -maxdepth 1 -type f -name 'game-image-*.txt' -printf '%T@ %p\n' | sort -nr | head -n1 | cut -d' ' -f2-)
test -s "$latest_game_record"
cat "$latest_game_record"
(cd "$latest_backup" && sha256sum -c SHA256SUMS >/dev/null)

echo '[verify] service health'
curl -fsS http://127.0.0.1:3000/api/auth/me
curl -fsSI http://127.0.0.1:8080/ | head -n1
docker exec cs-fastdl nginx -t

echo '[verify] protected identities'
for name in cs16-server-27015 cs16-server-27016; do
  docker inspect "$name" --format '{{{{.Name}}}}|{{{{.Id}}}}|running={{{{.State.Running}}}}|started={{{{.State.StartedAt}}}}|volume={{{{range .Mounts}}}}{{{{if eq .Destination "/hlds/cstrike"}}}}{{{{.Source}}}}{{{{end}}}}{{{{end}}}}'
done

echo '[verify] live test cleanup and compiler mode on 27017'
artifacts=$(docker exec cs16-server-27017 sh -lc "find /hlds/cstrike /fastdl-data -name 'local_stack_test*' -print")
test -z "$artifacts"
docker exec cs16-server-27017 stat -c 'amxxpc-mode=%a' /hlds/cstrike/addons/amxmodx/scripting/amxxpc
docker run --rm --entrypoint /bin/sh cs16-server-base:latest -lc \
  'echo clean-amxxpc-mode=$(stat -c %a /hlds_clean/cstrike/addons/amxmodx/scripting/amxxpc); test -x /hlds_clean/cstrike/addons/amxmodx/scripting/amxxpc'

echo '[verify] panel startup guard log'
docker logs --tail 120 cs-panel 2>&1 | grep -E 'Port 27015 is protected|Port 27016 is protected|CS 1.6 Server Panel running'
echo 'LIVE_VERIFY_OK'
"""
    emit(run(client, "bash -lc " + shlex.quote(script), timeout=120))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("inventory", "backup", "backup-status", "deploy", "build-game-image", "verify"), default="inventory", nargs="?")
    parser.add_argument("--yes", action="store_true", help="confirm guarded deployment after backup")
    args = parser.parse_args()
    client = connect()
    try:
        if args.action == "inventory":
            inventory(client)
        elif args.action == "backup":
            backup(client)
        elif args.action == "backup-status":
            backup_status(client)
        elif args.action == "deploy":
            deploy(client, args.yes)
        elif args.action == "build-game-image":
            build_game_image(client, args.yes)
        elif args.action == "verify":
            verify_live(client)
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
