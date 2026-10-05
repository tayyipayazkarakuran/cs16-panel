#!/bin/bash

# Configuration environment variables
PORT=${PORT:-27015}
MAXPLAYERS=${MAXPLAYERS:-32}
START_MAP=${START_MAP:-de_dust2}
RCON_PASSWORD=${RCON_PASSWORD:-}
SERVER_NAME=${SERVER_NAME:-"CS 1.6 Server"}

echo "Starting CS 1.6 Server Setup..."

# Fix Steam API initialization crash by symlinking steamclient.so
mkdir -p /root/.steam/sdk32
ln -sf /opt/steamcmd/linux32/steamclient.so /root/.steam/sdk32/steamclient.so

# Copy clean files to volume if it's empty
if [ ! -f "/hlds/cstrike/liblist.gam" ]; then
    echo "Initializing clean cstrike directory..."
    mkdir -p /hlds/cstrike
    cp -a /hlds_clean/cstrike/. /hlds/cstrike/
fi

# Ensure reunion.cfg exists in cstrike directory
if [ -f "/hlds/reunion.cfg" ]; then
    cp /hlds/reunion.cfg /hlds/cstrike/reunion.cfg
fi

CFG=/hlds/cstrike/server.cfg

# Replace (or append) one cvar line. Matches the cvar name exactly at the start
# of a line, so e.g. "log" never deletes a hostname that contains "log".
set_cvar() {
    name="$1"; value="$2"
    if [ -f "$CFG" ] && grep -qE "^[[:space:]]*${name}[[:space:]]" "$CFG"; then
        sed -i -E "s|^[[:space:]]*${name}[[:space:]].*$|${name} ${value}|" "$CFG"
    else
        echo "${name} ${value}" >> "$CFG"
    fi
}

ensure_cvar() {
    name="$1"; value="$2"
    if [ ! -f "$CFG" ] || ! grep -qE "^[[:space:]]*${name}[[:space:]]" "$CFG"; then
        echo "${name} ${value}" >> "$CFG"
    fi
}

if [ ! -f "$CFG" ]; then
    echo "Creating default server.cfg..."
    printf 'hostname "%s"\nrcon_password "%s"\n' "$SERVER_NAME" "$RCON_PASSWORD" > "$CFG"
fi

# Values the owner may change in the panel are only added when missing.
ensure_cvar hostname "\"$SERVER_NAME\""
ensure_cvar rcon_password "\"$RCON_PASSWORD\""

# Performance/network tuning is enforced on every boot.
set_cvar sys_ticrate 1000
set_cvar fps_max 1000
set_cvar sv_minrate 25000
set_cvar sv_maxrate 100000
set_cvar sv_minupdaterate 20
set_cvar sv_maxupdaterate 102
set_cvar sv_unlag 1
set_cvar sv_maxunlag 0.5
set_cvar sv_unlagsamples 1
set_cvar sv_unlagpush 0
set_cvar sv_timeout 60
set_cvar sv_rehlds_movecmdrate_max_avg 2000
set_cvar sv_rehlds_movecmdrate_max_burst 5000
set_cvar sv_rehlds_movecmdrate_avg_punish -1
set_cvar sv_rehlds_movecmdrate_burst_punish -1
set_cvar sv_rehlds_local_gametime 1

# Logging is required for the panel's connection history.
set_cvar log on
set_cvar sv_logbans 1
set_cvar sv_logecho 1
set_cvar sv_logfile 1
set_cvar sv_log_onefile 0

# FastDL: always point clients at this server's directory (fresh and old volumes).
if [ -n "$SV_DOWNLOADURL" ]; then
    set_cvar sv_downloadurl "\"$SV_DOWNLOADURL\""
    set_cvar sv_allowdownload 1
fi

# Per-server MySQL credentials for AMX Mod X (written by the panel).
if [ -n "$AMX_SQL_DB" ]; then
    SQL_CFG=/hlds/cstrike/addons/amxmodx/configs/sql.cfg
    mkdir -p "$(dirname "$SQL_CFG")"
    touch "$SQL_CFG"
    for pair in "amx_sql_host:$AMX_SQL_HOST" "amx_sql_user:$AMX_SQL_USER" "amx_sql_pass:$AMX_SQL_PASS" "amx_sql_db:$AMX_SQL_DB" "amx_sql_type:mysql"; do
        key="${pair%%:*}"; val="${pair#*:}"
        if grep -qE "^[[:space:]]*${key}[[:space:]]" "$SQL_CFG"; then
            sed -i -E "s|^[[:space:]]*${key}[[:space:]].*$|${key} \"${val}\"|" "$SQL_CFG"
        else
            echo "${key} \"${val}\"" >> "$SQL_CFG"
        fi
    done
fi

# Ensure mapcycle.txt exists
if [ ! -f "/hlds/cstrike/mapcycle.txt" ]; then
    echo "Creating default mapcycle.txt..."
    cat <<EOT > /hlds/cstrike/mapcycle.txt
de_dust2
de_inferno
de_nuke
de_train
de_mirage
cs_office
cs_assault
EOT
fi

# Create a symlink for scripting if it does not exist
if [ ! -d "/hlds/cstrike/addons/amxmodx/scripting" ] && [ -d "/hlds_clean/cstrike/addons/amxmodx/scripting" ]; then
    echo "Restoring AMX Mod X scripting directory..."
    mkdir -p /hlds/cstrike/addons/amxmodx
    cp -r /hlds_clean/cstrike/addons/amxmodx/scripting /hlds/cstrike/addons/amxmodx/
fi

# Restored/legacy volumes can lose Unix mode bits on the compiler binary.
if [ -f "/hlds/cstrike/addons/amxmodx/scripting/amxxpc" ]; then
    chmod 0755 /hlds/cstrike/addons/amxmodx/scripting/amxxpc
fi

# Check if startup_map.txt exists and override START_MAP
if [ -f "/hlds/cstrike/startup_map.txt" ]; then
    MAP_FILE_VAL=$(head -n 1 /hlds/cstrike/startup_map.txt | tr -cd 'A-Za-z0-9_.-')
    if [ -n "$MAP_FILE_VAL" ]; then
        START_MAP="$MAP_FILE_VAL"
    fi
fi

cd /hlds
# Run hlds_run with -pingboost 2 and +sys_ticrate 1000 for stable 1000 FPS timing on Linux hosts
exec ./hlds_run -game cstrike -console -pingboost 2 +port "$PORT" +maxplayers "$MAXPLAYERS" +map "$START_MAP" +sys_ticrate 1000 +fps_max 1000
