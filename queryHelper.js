const dgram = require('dgram');

/**
 * Sends a UDP query to a HLDS server and returns the raw response buffer.
 */
function sendUdpRequest(host, port, buffer, timeout = 1000) {
    return new Promise((resolve, reject) => {
        const client = dgram.createSocket('udp4');
        let timer = setTimeout(() => {
            client.close();
            reject(new Error('UDP query timeout'));
        }, timeout);

        client.on('message', (msg) => {
            clearTimeout(timer);
            client.close();
            resolve(msg);
        });

        client.on('error', (err) => {
            clearTimeout(timer);
            client.close();
            reject(err);
        });

        client.send(buffer, 0, buffer.length, port, host, (err) => {
            if (err) {
                clearTimeout(timer);
                client.close();
                reject(err);
            }
        });
    });
}

/**
 * Parses the actual A2S_INFO response body.
 */
function parseInfoResponse(response) {
    let offset = 4;
    const header = response.readUInt8(offset);
    offset++;

    // If it's a Source engine response (0x49) or legacy GoldSrc (0x6D)
    if (header !== 0x49 && header !== 0x6D) {
        throw new Error(`Unexpected header: ${header.toString(16)}`);
    }

    let protocol = 0;
    let name = '';
    let map = '';
    let folder = '';
    let game = '';
    let players = 0;
    let maxPlayers = 0;

    if (header === 0x6D) { // 'm' - Legacy GoldSrc format
        // string: address
        let end = response.indexOf(0x00, offset);
        offset = end + 1;

        // string: hostname
        end = response.indexOf(0x00, offset);
        name = response.toString('utf8', offset, end);
        offset = end + 1;

        // string: mapname
        end = response.indexOf(0x00, offset);
        map = response.toString('ascii', offset, end);
        offset = end + 1;

        // string: gamedir
        end = response.indexOf(0x00, offset);
        folder = response.toString('ascii', offset, end);
        offset = end + 1;

        // string: gamedescription
        end = response.indexOf(0x00, offset);
        game = response.toString('utf8', offset, end);
        offset = end + 1;

        // byte: active players
        players = response.readUInt8(offset);
        offset++;

        // byte: max players
        maxPlayers = response.readUInt8(offset);
        offset++;

        // byte: protocol version
        protocol = response.readUInt8(offset);
        offset++;
    } else { // 0x49 - 'I' Source Engine format (used by modern HLDS updates)
        protocol = response.readUInt8(offset);
        offset++;

        // string: hostname
        let end = response.indexOf(0x00, offset);
        name = response.toString('utf8', offset, end);
        offset = end + 1;

        // string: mapname
        end = response.indexOf(0x00, offset);
        map = response.toString('ascii', offset, end);
        offset = end + 1;

        // string: gamedir
        end = response.indexOf(0x00, offset);
        folder = response.toString('ascii', offset, end);
        offset = end + 1;

        // string: gamedescription
        end = response.indexOf(0x00, offset);
        game = response.toString('utf8', offset, end);
        offset = end + 1;

        // short: steam AppID
        offset += 2; 

        // byte: active players
        players = response.readUInt8(offset);
        offset++;

        // byte: max players
        maxPlayers = response.readUInt8(offset);
        offset++;
    }

    return {
        name,
        map,
        players,
        maxPlayers,
        online: true
    };
}

/**
 * Gets basic server info (A2S_INFO query) with challenge support.
 */
async function getServerInfo(host, port) {
    const queryBuffer = Buffer.concat([
        Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
        Buffer.from('TSource Engine Query\x00')
    ]);

    try {
        let response = await sendUdpRequest(host, port, queryBuffer, 1000);
        
        // Check if response is a challenge (0x41)
        const header = response.readUInt8(4);
        if (header === 0x41) { // 'A'
            const challenge = response.slice(5, 9);
            
            // Re-send query appending the 4-byte challenge code
            const queryWithChallenge = Buffer.concat([
                Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
                Buffer.from('TSource Engine Query\x00'),
                challenge
            ]);
            
            response = await sendUdpRequest(host, port, queryWithChallenge, 1200);
        }

        return parseInfoResponse(response);
    } catch (err) {
        return {
            name: 'Offline',
            map: '-',
            players: 0,
            maxPlayers: 0,
            online: false,
            error: err.message
        };
    }
}

const challengeCache = {}; // key: host:port, value: { challengeNumber, timestamp }

/**
 * Sends RCON command to GoldSrc server.
 */
async function sendRconCommand(host, port, rconPassword, command) {
    try {
        const cacheKey = `${host}:${port}`;
        let challengeNumber = null;
        const now = Date.now();

        if (challengeCache[cacheKey] && (now - challengeCache[cacheKey].timestamp < 30000)) {
            challengeNumber = challengeCache[cacheKey].challengeNumber;
        }

        if (!challengeNumber) {
            // Step 1: Get challenge code
            const challengeQuery = Buffer.concat([
                Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
                Buffer.from('challenge rcon\n')
            ]);
            
            let challengeResponse;
            try {
                challengeResponse = await sendUdpRequest(host, port, challengeQuery, 1000);
            } catch (e) {
                return 'RCON Connection failed (no challenge response)';
            }

            const responseStr = challengeResponse.toString('ascii');
            const match = responseStr.match(/challenge rcon (\d+)/);
            if (!match) {
                return `RCON failed to parse challenge. Server response: ${responseStr}`;
            }
            challengeNumber = match[1];
            challengeCache[cacheKey] = { challengeNumber, timestamp: Date.now() };
        }

        // Step 2: Send RCON command with challenge
        const rconBuffer = Buffer.concat([
            Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
            Buffer.from(`rcon ${challengeNumber} "${rconPassword}" ${command}\n`)
        ]);

        const rconResponse = await sendUdpRequest(host, port, rconBuffer, 2000);
        
        let result = rconResponse.slice(5).toString('utf8').trim();
        result = result.replace(/\0/g, '');

        // If challenge expired, the server returns "challenge rcon <new_number>"
        const match = result.match(/challenge rcon (\d+)/);
        if (match) {
            challengeNumber = match[1];
            challengeCache[cacheKey] = { challengeNumber, timestamp: Date.now() };

            const retryBuffer = Buffer.concat([
                Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
                Buffer.from(`rcon ${challengeNumber} "${rconPassword}" ${command}\n`)
            ]);

            const retryResponse = await sendUdpRequest(host, port, retryBuffer, 2000);
            let retryResult = retryResponse.slice(5).toString('utf8').trim();
            retryResult = retryResult.replace(/\0/g, '');
            return retryResult;
        }

        return result;
    } catch (err) {
        return `RCON Error: ${err.message}`;
    }
}

/**
 * Gets server stats (FPS, CPU) by running RCON 'stats' command.
 */
async function getServerStats(host, port, rconPassword) {
    const statsOutput = await sendRconCommand(host, port, rconPassword, 'stats');
    
    const lines = statsOutput.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
        return { fps: 0, cpu: 0, uptime: 0 };
    }
    
    const dataLine = lines[1];
    const parts = dataLine.split(/\s+/);
    if (parts.length >= 7) {
        const cpu = parseFloat(parts[0]) || 0;
        const uptime = parseInt(parts[3]) || 0;
        const fps = parseFloat(parts[5]) || 0;
        return { fps, cpu, uptime };
    }

    return { fps: 0, cpu: 0, uptime: 0, raw: statsOutput };
}

/**
 * Gets active players list (A2S_PLAYER query).
 */
async function getPlayersList(host, port) {
    try {
        const challengeQuery = Buffer.concat([
            Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
            Buffer.from([0x55, 0xFF, 0xFF, 0xFF, 0xFF])
        ]);

        const challengeResponse = await sendUdpRequest(host, port, challengeQuery, 1000);
        if (challengeResponse.readUInt8(4) !== 0x41) {
            return [];
        }
        
        const challenge = challengeResponse.slice(5, 9);

        const playerQuery = Buffer.concat([
            Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x55]),
            challenge
        ]);

        const playerResponse = await sendUdpRequest(host, port, playerQuery, 1500);
        if (playerResponse.readUInt8(4) !== 0x44) {
            return [];
        }

        let offset = 5;
        const playerCount = playerResponse.readUInt8(offset);
        offset++;

        const players = [];
        for (let i = 0; i < playerCount; i++) {
            if (offset >= playerResponse.length) break;
            
            const index = playerResponse.readUInt8(offset);
            offset++;

            const end = playerResponse.indexOf(0x00, offset);
            if (end === -1) break;
            const name = playerResponse.toString('utf8', offset, end);
            offset = end + 1;

            if (offset + 4 > playerResponse.length) break;
            const frags = playerResponse.readInt32LE(offset);
            offset += 4;

            if (offset + 4 > playerResponse.length) break;
            const timeSeconds = playerResponse.readFloatLE(offset);
            offset += 4;

            const hours = Math.floor(timeSeconds / 3600);
            const minutes = Math.floor((timeSeconds % 3600) / 60);
            const seconds = Math.floor(timeSeconds % 60);
            const timeStr = `${hours > 0 ? hours + 'h ' : ''}${minutes}m ${seconds}s`;

            players.push({
                index,
                name: name || 'Connecting...',
                frags,
                time: timeStr
            });
        }
        return players;
    } catch (e) {
        return [];
    }
}

const fs = require('fs');
const IS_DOCKER = fs.existsSync('/.dockerenv');

function getServerIp(inspectInfo) {
    if (IS_DOCKER) {
        const networks = inspectInfo.NetworkSettings.Networks;
        if (networks && networks['cs-network'] && networks['cs-network'].IPAddress) {
            return networks['cs-network'].IPAddress;
        }
        for (const name in networks) {
            if (networks[name].IPAddress) return networks[name].IPAddress;
        }
    }
    return '127.0.0.1';
}

module.exports = {
    getServerInfo,
    sendRconCommand,
    getServerStats,
    getPlayersList,
    getServerIp
};
