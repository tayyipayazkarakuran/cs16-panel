<?php
// Minimal GoldSrc/Source A2S query client (INFO + PLAYER) with challenge support.

function gs_udp_request(string $host, int $port, string $payload, float $timeout = 1.5): ?string
{
    $socket = @stream_socket_client("udp://{$host}:{$port}", $errno, $errstr, $timeout);
    if (!$socket) {
        return null;
    }
    stream_set_timeout($socket, (int) $timeout, (int) (($timeout - (int) $timeout) * 1e6));
    fwrite($socket, $payload);
    $response = fread($socket, 4096);
    fclose($socket);
    return ($response === false || $response === '') ? null : $response;
}

function gs_read_string(string $data, int &$offset): string
{
    $end = strpos($data, "\0", $offset);
    if ($end === false) {
        $end = strlen($data);
    }
    $value = substr($data, $offset, $end - $offset);
    $offset = $end + 1;
    return $value;
}

function gs_query_info(string $host, int $port): ?array
{
    $query = "\xFF\xFF\xFF\xFFTSource Engine Query\0";
    $response = gs_udp_request($host, $port, $query);
    if ($response !== null && strlen($response) >= 9 && $response[4] === 'A') {
        $response = gs_udp_request($host, $port, $query . substr($response, 5, 4));
    }
    if ($response === null || strlen($response) < 6) {
        return null;
    }
    $type = $response[4];
    $offset = 5;
    if ($type === 'I') {
        $offset++; // protocol
        $name = gs_read_string($response, $offset);
        $map = gs_read_string($response, $offset);
        gs_read_string($response, $offset); // folder
        gs_read_string($response, $offset); // game
        $offset += 2; // app id
        $players = ord($response[$offset] ?? "\0");
        $max = ord($response[$offset + 1] ?? "\0");
        $bots = ord($response[$offset + 2] ?? "\0");
    } elseif ($type === 'm') {
        gs_read_string($response, $offset); // address
        $name = gs_read_string($response, $offset);
        $map = gs_read_string($response, $offset);
        gs_read_string($response, $offset);
        gs_read_string($response, $offset);
        $players = ord($response[$offset] ?? "\0");
        $max = ord($response[$offset + 1] ?? "\0");
        $bots = 0;
    } else {
        return null;
    }
    return ['name' => $name, 'map' => $map, 'players' => $players, 'max_players' => $max, 'bots' => $bots];
}

function gs_query_players(string $host, int $port): array
{
    $response = gs_udp_request($host, $port, "\xFF\xFF\xFF\xFFU\xFF\xFF\xFF\xFF");
    if ($response === null || strlen($response) < 9 || $response[4] !== 'A') {
        return [];
    }
    $response = gs_udp_request($host, $port, "\xFF\xFF\xFF\xFFU" . substr($response, 5, 4));
    if ($response === null || strlen($response) < 6 || $response[4] !== 'D') {
        return [];
    }
    $count = ord($response[5]);
    $offset = 6;
    $players = [];
    for ($i = 0; $i < $count && $offset < strlen($response); $i++) {
        $offset++; // index
        $name = gs_read_string($response, $offset);
        if ($offset + 8 > strlen($response)) {
            break;
        }
        $score = unpack('l', substr($response, $offset, 4))[1];
        $time = unpack('f', substr($response, $offset + 4, 4))[1];
        $offset += 8;
        if ($name === '') {
            continue;
        }
        $players[] = ['name' => $name, 'score' => $score, 'time' => (int) $time];
    }
    usort($players, static fn ($a, $b) => $b['score'] <=> $a['score']);
    return $players;
}

function gs_format_duration(int $seconds): string
{
    $h = intdiv($seconds, 3600);
    $m = intdiv($seconds % 3600, 60);
    return $h > 0 ? sprintf('%d sa %02d dk', $h, $m) : sprintf('%d dk', $m);
}
