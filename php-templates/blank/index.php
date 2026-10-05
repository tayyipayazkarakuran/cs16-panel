<?php
// Your site root. Useful helpers provided by the panel:
//   panel_config()  -> ['db' => [...], 'game' => [...], 'site_url' => ...]
//   panel_db()      -> ready PDO connection to this server's MySQL database
$config = panel_config();
?><!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= htmlspecialchars($config['game']['name'] ?? 'Sitem', ENT_QUOTES, 'UTF-8') ?></title>
</head>
<body>
    <h1>Merhaba!</h1>
    <p>Bu dosyayı panelin Web Sitesi sekmesinden düzenleyebilir veya kendi sitenizi ZIP olarak yükleyebilirsiniz.</p>
    <?php
    try {
        $version = panel_db()->query('SELECT VERSION()')->fetchColumn();
        echo '<p>MySQL bağlantısı hazır (' . htmlspecialchars((string) $version, ENT_QUOTES, 'UTF-8') . ').</p>';
    } catch (Throwable $e) {
        echo '<p>MySQL bağlantısı kurulamadı.</p>';
    }
    ?>
</body>
</html>
