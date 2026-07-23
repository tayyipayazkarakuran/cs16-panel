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

# Ensure default server.cfg exists or update it
if [ ! -f "/hlds/cstrike/server.cfg" ]; then
    echo "Creating default server.cfg..."
    cat <<EOT > /hlds/cstrike/server.cfg
hostname "$SERVER_NAME"
rcon_password "$RCON_PASSWORD"
sys_ticrate 1000
fps_max 1000
sv_minrate 25000
sv_maxrate 100000
sv_minupdaterate 20
sv_maxupdaterate 102
sv_unlag 1
sv_maxunlag 0.5
sv_unlagsamples 1
sv_unlagpush 0
sv_timeout 60
sv_rehlds_movecmdrate_max_avg 2000
sv_rehlds_movecmdrate_max_burst 5000
sv_rehlds_movecmdrate_avg_punish -1
sv_rehlds_movecmdrate_burst_punish -1
sv_rehlds_local_gametime 1
log on
sv_logbans 1
sv_logecho 1
sv_logfile 1
sv_log_onefile 0
EOT
else
    # Ensure hostname exists in server.cfg without overwriting
    if ! grep -q "^[[:space:]]*hostname" /hlds/cstrike/server.cfg; then
        echo "hostname \"$SERVER_NAME\"" >> /hlds/cstrike/server.cfg
    fi
    # Ensure rcon_password exists in server.cfg without overwriting
    if ! grep -q "^[[:space:]]*rcon_password" /hlds/cstrike/server.cfg; then
        echo "rcon_password \"$RCON_PASSWORD\"" >> /hlds/cstrike/server.cfg
    fi
    # Enforce performance and network cvars to prevent duplicates/lag
    for cvar in sys_ticrate fps_max sv_minrate sv_maxrate sv_minupdaterate sv_maxupdaterate sv_unlag sv_maxunlag sv_unlagsamples sv_unlagpush sv_timeout sv_rehlds_movecmdrate_max_avg sv_rehlds_movecmdrate_max_burst sv_rehlds_movecmdrate_avg_punish sv_rehlds_movecmdrate_burst_punish sv_rehlds_local_gametime; do
        sed -i "/$cvar/d" /hlds/cstrike/server.cfg
    done
    echo "sys_ticrate 1000" >> /hlds/cstrike/server.cfg
    echo "fps_max 1000" >> /hlds/cstrike/server.cfg
    echo "sv_minrate 25000" >> /hlds/cstrike/server.cfg
    echo "sv_maxrate 100000" >> /hlds/cstrike/server.cfg
    echo "sv_minupdaterate 20" >> /hlds/cstrike/server.cfg
    echo "sv_maxupdaterate 102" >> /hlds/cstrike/server.cfg
    echo "sv_unlag 1" >> /hlds/cstrike/server.cfg
    echo "sv_maxunlag 0.5" >> /hlds/cstrike/server.cfg
    echo "sv_unlagsamples 1" >> /hlds/cstrike/server.cfg
    echo "sv_unlagpush 0" >> /hlds/cstrike/server.cfg
    echo "sv_timeout 60" >> /hlds/cstrike/server.cfg
    echo "sv_rehlds_movecmdrate_max_avg 2000" >> /hlds/cstrike/server.cfg
    echo "sv_rehlds_movecmdrate_max_burst 5000" >> /hlds/cstrike/server.cfg
    echo "sv_rehlds_movecmdrate_avg_punish -1" >> /hlds/cstrike/server.cfg
    echo "sv_rehlds_movecmdrate_burst_punish -1" >> /hlds/cstrike/server.cfg
    echo "sv_rehlds_local_gametime 1" >> /hlds/cstrike/server.cfg

    # Enforce logging settings so connection logs fallback can work
    for cvar in log sv_logbans sv_logecho sv_logfile sv_log_onefile; do
        sed -i "/$cvar/d" /hlds/cstrike/server.cfg
    done
    echo "log on" >> /hlds/cstrike/server.cfg
    echo "sv_logbans 1" >> /hlds/cstrike/server.cfg
    echo "sv_logecho 1" >> /hlds/cstrike/server.cfg
    echo "sv_logfile 1" >> /hlds/cstrike/server.cfg
    echo "sv_log_onefile 0" >> /hlds/cstrike/server.cfg

    # Set sv_downloadurl if provided by panel
    if [ -n "$SV_DOWNLOADURL" ]; then
        if ! grep -q "sv_downloadurl" /hlds/cstrike/server.cfg; then
            echo "sv_downloadurl \"$SV_DOWNLOADURL\"" >> /hlds/cstrike/server.cfg
        else
            sed -i "s|sv_downloadurl.*|sv_downloadurl \"$SV_DOWNLOADURL\"|g" /hlds/cstrike/server.cfg
        fi
    fi
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
    MAP_FILE_VAL=$(cat /hlds/cstrike/startup_map.txt | tr -d '\r\n ' | head -n 1)
    if [ -n "$MAP_FILE_VAL" ]; then
        START_MAP="$MAP_FILE_VAL"
    fi
fi

cd /hlds
# Run hlds_run with -pingboost 2 and +sys_ticrate 1000 for stable 1000 FPS timing on Linux hosts
exec ./hlds_run -game cstrike -console -pingboost 2 +port $PORT +maxplayers $MAXPLAYERS +map $START_MAP +sys_ticrate 1000 +fps_max 1000
