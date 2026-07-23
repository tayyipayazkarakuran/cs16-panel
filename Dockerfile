FROM debian:12-slim

# Enable 32-bit architecture for SteamCMD and HLDS
RUN dpkg --add-architecture i386 && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        tar \
        file \
        lib32gcc-s1 \
        lib32stdc++6 \
        libc6-i386 \
        lib32z1 \
        libstdc++6:i386 \
        libgcc-s1:i386 \
        sed \
        unzip \
        && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install SteamCMD
RUN mkdir -p /opt/steamcmd && \
    cd /opt/steamcmd && \
    curl -sSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar -xz

# Create HLDS directory
RUN mkdir -p /hlds

# Keep the large, slow HLDS download layer independent from entrypoint changes.
COPY download_hlds.sh /hlds/download_hlds.sh

# Fix CRLF line endings for Linux execution
RUN sed -i 's/\r$//' /hlds/download_hlds.sh && \
    chmod +x /hlds/download_hlds.sh

# Run SteamCMD download for HLDS AppID 90 steam_legacy branch
RUN /hlds/download_hlds.sh

# Entrypoint changes should not invalidate the nearly 1 GB SteamCMD layer.
COPY entrypoint.sh /hlds/entrypoint.sh
RUN sed -i 's/\r$//' /hlds/entrypoint.sh && chmod +x /hlds/entrypoint.sh

# Copy custom ReHLDS files over the original download
COPY files/ /hlds/

# Ensure binaries and the AMX compiler keep execution permissions in both the
# image and the clean-volume snapshot.
RUN chmod 0755 /hlds/hlds_run /hlds/hlds_linux /hlds/hltv && \
    chmod 0755 /hlds/cstrike/addons/amxmodx/scripting/amxxpc

# Install python3 for filesystem operations by the management panel
RUN apt-get update && apt-get install -y --no-install-recommends python3 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create backup clean cstrike directory to populate empty host volume mounts
RUN mkdir -p /hlds_clean && \
    cp -a /hlds/cstrike /hlds_clean/

# Environment configurations
ENV PORT=27015 \
    MAXPLAYERS=32 \
    START_MAP=de_dust2 \
    SERVER_NAME="CS 1.6 Server"

WORKDIR /hlds

ENTRYPOINT ["/hlds/entrypoint.sh"]
