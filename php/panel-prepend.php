<?php
// Runs before every request (auto_prepend_file). Confines the executing site
// to its own directory so one customer's PHP can never read another site's
// files or database credentials.
(static function (): void {
    $sitesRoot = '/var/www/html/servers/';
    $script = realpath($_SERVER['SCRIPT_FILENAME'] ?? '') ?: '';
    $port = 0;
    if (strncmp($script, $sitesRoot, strlen($sitesRoot)) === 0) {
        $port = (int) strtok(substr($script, strlen($sitesRoot)), '/');
    }
    if ($port <= 0) {
        http_response_code(404);
        exit('Site not found');
    }
    $site = $sitesRoot . $port;
    $data = '/var/www/html/.sites-data/' . $port;
    foreach (['/sessions', '/tmp'] as $sub) {
        if (!is_dir($data . $sub)) {
            @mkdir($data . $sub, 0770, true);
        }
    }
    ini_set('session.save_path', $data . '/sessions');
    ini_set('open_basedir', $site . '/:' . $data . '/');
    define('PANEL_SITE_PORT', $port);
    define('PANEL_SITE_ROOT', $site);
    define('PANEL_CONFIG_FILE', $data . '/config.php');
    define('PANEL_TMP_DIR', $data . '/tmp');
})();

/**
 * Site configuration written by the panel: database credentials, game server
 * address and public URLs. Usage: $db = panel_config()['db'];
 */
function panel_config(): array
{
    static $config = null;
    if ($config === null) {
        $config = is_file(PANEL_CONFIG_FILE) ? (array) require PANEL_CONFIG_FILE : [];
    }
    return $config;
}

/** Ready-to-use PDO connection to this server's MySQL database. */
function panel_db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $db = panel_config()['db'] ?? [];
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $db['host'] ?? 'cs-mysql', $db['port'] ?? 3306, $db['name'] ?? '');
        $pdo = new PDO($dsn, $db['user'] ?? '', $db['pass'] ?? '', [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 3,
        ]);
    }
    return $pdo;
}
