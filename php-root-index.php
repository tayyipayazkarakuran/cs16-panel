<?php
if (session_status() === PHP_SESSION_NONE) session_start();

if (isset($_GET['p'])) {
    $_SESSION['php_port'] = (int)$_GET['p'];
}

$port = $_SESSION['php_port'] ?? 0;

function rewriteUrls($html, $port) {
    if ($port <= 0 || $html === '') return $html;
    return preg_replace_callback('/((?:href|action|src)=["\'])([^"\']*)(["\'])/i', function($m) use ($port) {
        $attr = $m[1]; $url = $m[2]; $q = $m[3];
        if (preg_match('#^https?://#i', $url) || preg_match('#^//.#', $url)) return $m[0];
        if (preg_match('/(?:^|[?&])p=/', $url)) return $m[0];
        if ($url[0] === '?') {
            return $attr . 'p=' . $port . '&' . substr($url, 1) . $q;
        }
        if ($url[0] === '/' && strlen($url) > 1 && $url[1] !== '/') {
            $rest = substr($url, 1);
            $qs = ''; $hash = '';
            if (($i = strpos($rest, '?')) !== false) { $qs = substr($rest, $i); $rest = substr($rest, 0, $i); }
            if (($i = strpos($rest, '#')) !== false) { $hash = substr($rest, $i); $rest = substr($rest, 0, $i); }
            return $attr . $rest . '?p=' . $port . ($qs ? '&' . substr($qs, 1) : '') . $hash . $q;
        }
        return $m[0];
    }, $html);
}

if ($port > 0) {
    $serverDir = __DIR__ . '/servers/' . $port;
    if (is_dir($serverDir)) {
        chdir($serverDir);
        ob_start();
        require $serverDir . '/index.php';
        $html = ob_get_clean();
        echo rewriteUrls($html, $port);
        exit;
    }
    http_response_code(404);
    echo 'Server not found: ' . htmlspecialchars($port);
    exit;
}

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>CS Panel PHP</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #1a1a2e; color: #e0e0e0; }
        h1 { color: #00d4ff; }
        a { color: #00d4ff; text-decoration: none; display: block; margin: 8px 0; font-size: 18px; }
        a:hover { text-decoration: underline; }
        .server-list { background: #16213e; padding: 20px; border-radius: 8px; margin-top: 20px; }
    </style>
</head>
<body>
    <h1>CS Panel PHP</h1>
    <p>Use <code>/?p={port}</code> to access a server's PHP area.</p>
    <div class="server-list" id="servers">Loading servers...</div>
    <script>
    fetch('/api/servers', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }})
        .then(r => r.json())
        .then(data => {
            const list = document.getElementById('servers');
            const servers = data.value || data;
            if (!servers.length) { list.innerHTML = '<p>No servers found.</p>'; return; }
            list.innerHTML = servers.map(s =>
                '<a href="/?p=' + s.port + '">' + s.name + ' (:' + s.port + ')</a>'
            ).join('');
        })
        .catch(() => { document.getElementById('servers').innerHTML = '<p>Login to see servers.</p>'; });
    </script>
</body>
</html>
