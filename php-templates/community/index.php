<?php
declare(strict_types=1);
require __DIR__ . '/lib/goldsrc.php';

$settings = require __DIR__ . '/settings.php';
$config = function_exists('panel_config') ? panel_config() : [];
$game = $config['game'] ?? ['name' => 'CS 1.6 Server', 'host' => '127.0.0.1', 'query_host' => '127.0.0.1', 'port' => 27015];
$address = $game['host'] . ':' . $game['port'];

$info = gs_query_info((string) $game['query_host'], (int) $game['port']);
$players = $info ? gs_query_players((string) $game['query_host'], (int) $game['port']) : [];
$title = $settings['title'] !== '' ? $settings['title'] : ($info['name'] ?? $game['name']);

$leaderboard = [];
if (!empty($settings['show_stats']) && function_exists('panel_db')) {
    try {
        $pdo = panel_db();
        foreach (['csstats', 'amx_stats', 'csstats_players'] as $table) {
            $exists = $pdo->query("SHOW TABLES LIKE " . $pdo->quote($table))->fetchColumn();
            if ($exists) {
                $leaderboard = $pdo->query("SELECT name, kills, deaths, hs FROM `{$table}` ORDER BY kills DESC LIMIT 15")->fetchAll();
                break;
            }
        }
    } catch (Throwable $e) {
        $leaderboard = [];
    }
}

function e(?string $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}
?><!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e($title) ?></title>
    <meta name="description" content="<?= e($settings['tagline']) ?>">
    <link rel="stylesheet" href="assets/style.css">
    <style>:root { --accent: <?= e(preg_match('/^#[0-9a-fA-F]{3,8}$/', $settings['accent_color']) ? $settings['accent_color'] : '#f5a524') ?>; }</style>
</head>
<body>
<header class="hero">
    <div class="wrap">
        <span class="badge <?= $info ? 'on' : 'off' ?>"><?= $info ? 'ÇEVRİMİÇİ' : 'ÇEVRİMDIŞI' ?></span>
        <h1><?= e($title) ?></h1>
        <p class="tagline"><?= e($settings['tagline']) ?></p>
        <div class="actions">
            <a class="btn primary" href="steam://connect/<?= e($address) ?>">Sunucuya Bağlan</a>
            <button class="btn" type="button" data-copy="<?= e($address) ?>">IP Kopyala: <?= e($address) ?></button>
            <?php if (!empty($settings['discord_url'])): ?>
                <a class="btn" href="<?= e($settings['discord_url']) ?>" rel="noopener" target="_blank">Discord</a>
            <?php endif; ?>
        </div>
    </div>
</header>

<main class="wrap grid">
    <section class="card stats">
        <div><span>Harita</span><strong><?= e($info['map'] ?? '—') ?></strong></div>
        <div><span>Oyuncular</span><strong><?= $info ? (int) $info['players'] . ' / ' . (int) $info['max_players'] : '—' ?></strong></div>
        <div><span>Adres</span><strong><?= e($address) ?></strong></div>
    </section>

    <section class="card">
        <h2>Şu an oyunda</h2>
        <?php if (!$players): ?>
            <p class="muted">Şu anda sunucuda oyuncu yok. İlk sen ol!</p>
        <?php else: ?>
            <table>
                <thead><tr><th>Oyuncu</th><th>Skor</th><th>Süre</th></tr></thead>
                <tbody>
                <?php foreach ($players as $p): ?>
                    <tr><td><?= e($p['name']) ?></td><td><?= (int) $p['score'] ?></td><td><?= e(gs_format_duration($p['time'])) ?></td></tr>
                <?php endforeach; ?>
                </tbody>
            </table>
        <?php endif; ?>
    </section>

    <?php if ($leaderboard): ?>
    <section class="card wide">
        <h2>En iyiler</h2>
        <table>
            <thead><tr><th>#</th><th>Oyuncu</th><th>Öldürme</th><th>Ölüm</th><th>K/D</th><th>Kafadan</th></tr></thead>
            <tbody>
            <?php foreach ($leaderboard as $i => $row): $deaths = max(1, (int) $row['deaths']); ?>
                <tr>
                    <td><?= $i + 1 ?></td><td><?= e($row['name']) ?></td><td><?= (int) $row['kills'] ?></td>
                    <td><?= (int) $row['deaths'] ?></td><td><?= number_format((int) $row['kills'] / $deaths, 2) ?></td><td><?= (int) $row['hs'] ?></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    </section>
    <?php endif; ?>

    <?php if (!empty($settings['rules'])): ?>
    <section class="card wide">
        <h2>Kurallar</h2>
        <ol class="rules">
            <?php foreach ($settings['rules'] as $rule): ?><li><?= e($rule) ?></li><?php endforeach; ?>
        </ol>
    </section>
    <?php endif; ?>
</main>

<footer class="wrap footer">© <?= date('Y') ?> <?= e($title) ?></footer>
<script src="assets/site.js" defer></script>
</body>
</html>
