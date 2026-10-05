// Landing page: live server list + plans from the public API (no inline JS, CSP-safe).
(function () {
    'use strict';

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'class') node.className = attrs[key];
            else if (key === 'text') node.textContent = attrs[key];
            else node.setAttribute(key, attrs[key]);
        });
        (children || []).forEach(function (child) {
            if (child === null || child === undefined) return;
            node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        });
        return node;
    }

    function money(value, currency) {
        return Number(value || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + currency;
    }

    var rows = document.getElementById('server-rows');
    var timer = null;

    function loadServers() {
        fetch('/api/servers/public').then(function (r) { return r.json(); }).then(function (data) {
            var servers = data.servers || [];
            var players = 0;
            rows.replaceChildren();
            if (!servers.length) {
                rows.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'table-empty', text: 'Şu anda listelenen sunucu yok.' })]));
            }
            servers.forEach(function (s) {
                players += s.players || 0;
                var address = s.ip + ':' + s.port;
                var online = s.status === 'online';
                rows.appendChild(el('tr', {}, [
                    el('td', {}, [el('strong', { text: s.name })]),
                    el('td', {}, [el('a', { href: 'steam://connect/' + address, class: 'mono', text: address })]),
                    el('td', { text: s.map || '—' }),
                    el('td', { class: 'num', text: online ? (s.players + ' / ' + s.maxplayers) : '—' }),
                    el('td', {}, [el('span', { class: 'badge ' + (online ? 'badge-success' : 'badge-danger') }, [el('span', { class: 'dot ' + (online ? 'dot-online' : 'dot-offline') }), online ? 'Çevrimiçi' : 'Kapalı'])])
                ]));
            });
            document.getElementById('stat-servers').textContent = String(servers.filter(function (s) { return s.status === 'online'; }).length);
            document.getElementById('stat-players').textContent = String(players);
        }).catch(function () {
            rows.replaceChildren(el('tr', {}, [el('td', { colspan: '5', class: 'table-empty', text: 'Sunucu listesi alınamadı.' })]));
        });
    }

    function loadConfig() {
        fetch('/api/public/config').then(function (r) { return r.json(); }).then(function (cfg) {
            document.querySelectorAll('[data-site-name]').forEach(function (n) { n.textContent = cfg.siteName; });
            document.title = cfg.siteName + ' · CS 1.6 Sunucu Kiralama';
            if (cfg.supportContact) document.getElementById('support').textContent = 'Destek: ' + cfg.supportContact;
            var box = document.getElementById('plans');
            box.replaceChildren();
            (cfg.plans || []).forEach(function (p) {
                var card = el('div', { class: 'card plan' + (p.highlighted ? ' highlight' : ''), 'data-ribbon': 'EN POPÜLER' }, [
                    el('div', {}, [el('h3', { text: p.name }), p.description ? el('p', { class: 'small muted', text: p.description }) : null]),
                    el('div', { class: 'price' }, [p.price > 0 ? money(p.price, cfg.currency) : 'Ücretsiz', el('small', { text: ' / ' + p.duration_days + ' gün' })]),
                    el('ul', {}, [el('li', { text: '✓ ' + p.max_players + ' oyuncu slotu' })].concat((p.features || []).map(function (f) { return el('li', { text: '✓ ' + f }); }))),
                    el('a', { class: 'btn ' + (p.highlighted ? 'btn-primary' : ''), href: '/#/register', text: p.is_trial ? 'Ücretsiz dene' : 'Kirala' })
                ]);
                box.appendChild(card);
            });
            if (!cfg.plans || !cfg.plans.length) box.appendChild(el('p', { class: 'muted', text: 'Şu anda satışta paket yok.' }));
        }).catch(function () { /* keep static content */ });
    }

    document.getElementById('year').textContent = String(new Date().getFullYear());
    document.getElementById('refresh-servers').addEventListener('click', loadServers);
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) { clearInterval(timer); timer = null; }
        else if (!timer) { loadServers(); timer = setInterval(loadServers, 30000); }
    });
    loadConfig();
    loadServers();
    timer = setInterval(loadServers, 30000);
})();
