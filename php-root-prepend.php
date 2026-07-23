<?php
if (session_status() === PHP_SESSION_NONE) session_start();

if (isset($_GET['p'])) {
    $_SESSION['php_port'] = (int)$_GET['p'];
}

$port = $_SESSION['php_port'] ?? 0;
if ($port > 0 && !isset($_GET['p']) && !empty($_SERVER['QUERY_STRING'])) {
    header('Location: /?p=' . $port . '&' . $_SERVER['QUERY_STRING']);
    exit;
} elseif ($port > 0 && !isset($_GET['p'])) {
    header('Location: /?p=' . $port);
    exit;
}
