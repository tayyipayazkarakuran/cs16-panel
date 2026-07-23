#!/bin/bash
set -e

# AppID 90 is notorious for downloading incomplete files on the first try.
# We run it in a loop to ensure everything is downloaded and validated.
for i in {1..8}; do
  echo "SteamCMD download attempt $i..."
  /opt/steamcmd/steamcmd.sh +force_install_dir /hlds +login anonymous +app_set_config 90 mod cstrike +app_update 90 -beta steam_legacy validate +quit || true
  
  # Check if the core cstrike dlls or engine binary exists to verify completion
  if [ -f "/hlds/cstrike/dlls/cs.so" ] || [ -f "/hlds/cstrike/dlls/cs_i386.so" ]; then
    echo "CS 1.6 Server files downloaded successfully."
    exit 0
  fi
  
  echo "Attempt $i completed, but key files are missing. Retrying..."
  sleep 2
done

echo "Error: Failed to download complete HLDS server files after 8 attempts."
exit 1
