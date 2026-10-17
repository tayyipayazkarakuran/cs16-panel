// Tab bodies of the server detail page.
import { append,
    api, h, clear, icon, btn, linkBtn, card, badge, table, tableActions, field, input, select, switchControl, toast, toastError,
    confirmDialog, formDialog, openModal, withBusy, loading, errorBox, emptyState, copyable, copyText,
    fmtBytes, fmtDateTime, fmtRelative, generatePassword, dropdown, menuItem, menuSep, moreMenu, searchInput,
    uploadWithProgress, downloadFile, downloadCsv, saveBlob, validators, state
} from '../core.js';
import { createFileManager } from '../components/fileManager.js';

const enc = encodeURIComponent;

/** Shown by tabs that need a running server; offers a one-click start. */
function offlineNotice(server, message = 'Bu bölümü kullanmak için sunucuyu başlatın.') {
    const startBtn = server && server.state !== 'running' && !server.suspended
        ? btn('Sunucuyu başlat', { variant: 'success', iconName: 'play', onClick: async e => withBusy(e.currentTarget, async () => {
            try {
                const data = await api(`/api/servers/${server.id}/start`, { method: 'POST', timeoutMs: 180000 });
                toast(`${data.message} Hazır olduğunda bu bölüm otomatik açılır.`, 'success');
                const { loadServers } = await import('../main.js');
                const poll = (n = 0) => loadServers().then(list => {
                    const s = list.find(x => x.id === server.id);
                    if (n < 10 && !(s && s.state === 'running')) setTimeout(() => poll(n + 1), 2000);
                }).catch(() => {});
                poll();
            } catch (error) { toastError(error); }
        }) })
        : null;
    return emptyState({ iconName: 'stop', title: 'Sunucu çalışmıyor', text: message, action: startBtn });
}

function refreshBtn(onClick, title = 'Yenile') {
    return btn(null, { size: 'sm', iconName: 'refresh', title, onClick });
}

/** Repaint a list whenever a search box changes. */
function filterRows(rows, term, keys) {
    if (!term) return rows;
    const t = term.toLowerCase();
    return rows.filter(r => keys.some(k => String(typeof k === 'function' ? k(r) : r[k] || '').toLowerCase().includes(t)));
}

/** Upload one file with a progress bar inside `host`; resolves with the JSON response. */
async function uploadWithBar(host, url, form, label) {
    const bar = h('div');
    const text = h('span', { class: 'small muted tabular' }, '0%');
    const box = h('div', { class: 'transfer' }, h('div', { class: 'head' }, h('strong', { class: 'small' }, label), text), h('div', { class: 'bar' }, bar));
    host.replaceChildren(box);
    host.hidden = false;
    try {
        const data = await uploadWithProgress(url, form, {
            onProgress: (loaded, total) => {
                const pct = Math.round(loaded / total * 100);
                bar.style.width = `${pct}%`;
                text.textContent = `%${pct} · ${fmtBytes(loaded)} / ${fmtBytes(total)}`;
            },
            onUploaded: () => { text.textContent = 'Sunucuda işleniyor…'; }
        });
        box.classList.add('is-success');
        bar.style.width = '100%';
        text.textContent = 'Tamamlandı';
        setTimeout(() => { host.hidden = true; }, 2500);
        return data;
    } catch (error) {
        box.classList.add('is-error');
        text.textContent = error.message;
        throw error;
    }
}

function banDialog(server, { target = '', kind = 'steam', name = '' } = {}) {
    return formDialog({
        title: name ? `${name} — yasakla` : 'Yasak ekle',
        fields: [
            { name: 'kind', label: 'Tür', type: 'select', value: kind, options: [{ value: 'steam', label: 'SteamID' }, { value: 'ip', label: 'IP adresi' }] },
            { name: 'target', label: 'SteamID veya IP', value: target, placeholder: 'STEAM_0:1:12345 veya 1.2.3.4', required: true, code: true,
                validate: (v, values) => (values.kind === 'ip' ? (validators.ip(v.trim()) ? null : 'Geçerli bir IPv4 adresi girin.') : (validators.steamId(v.trim()) ? null : 'SteamID STEAM_0:X:XXXX biçiminde olmalı.')) },
            { name: 'duration', label: 'Süre (dakika, 0 = kalıcı)', type: 'number', value: '0', min: 0, max: 525600 }
        ],
        submitText: 'Yasakla',
        danger: true,
        onSubmit: values => {
            if (server.state !== 'running') throw new Error('Yasak eklemek için sunucu çalışıyor olmalı.');
            return api(`/api/admins/${server.id}/ban`, { method: 'POST', body: { target: values.target.trim(), duration: values.duration, isIp: values.kind === 'ip' } });
        }
    });
}

// ---------------------------------------------------------------------------
//  Overview (connection info + live resource usage)
// ---------------------------------------------------------------------------

function sparkline(values, max) {
    const w = 120;
    const hgt = 36;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'sparkline');
    svg.setAttribute('aria-hidden', 'true');
    if (values.length < 2) return svg;
    const top = Math.max(max || 0, ...values, 1);
    const step = w / (values.length - 1);
    const pts = values.map((v, i) => [i * step, hgt - 2 - (v / top) * (hgt - 4)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    area.setAttribute('class', 'area');
    area.setAttribute('d', `${line} L${w} ${hgt} L0 ${hgt} Z`);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'line');
    path.setAttribute('d', line);
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, path);
    return svg;
}

function meterTile({ label, iconName, value, meta, pct = null, spark = null }) {
    const level = pct === null ? '' : pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
    return h('div', { class: 'card stat' },
        h('div', { class: 'stat-label' }, icon(iconName, 'icon-sm'), label),
        h('div', { class: 'stat-value' }, value),
        pct !== null ? h('div', { class: `meter-bar ${level}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-label': label },
            h('div', { style: { width: `${Math.max(0, Math.min(100, pct))}%` } })) : null,
        spark,
        meta ? h('div', { class: 'stat-meta' }, meta) : null);
}

function fmtRate(bytesPerSec) {
    return `${fmtBytes(Math.max(0, bytesPerSec))}/sn`;
}

function fmtUptime(startedAt) {
    if (!startedAt) return '—';
    const s = Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000);
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    return d ? `${d} g ${hh} sa` : hh ? `${hh} sa ${mm} dk` : `${mm} dk`;
}

export function overviewTab({ server, panel, onCleanup }) {
    const tiles = h('div', { class: 'grid grid-4' }, loading('Kaynak kullanımı ölçülüyor…'));
    const history = { cpu: [], mem: [] };
    let lastNet = null;
    let timer = null;

    async function sample() {
        try {
            const data = await api(`/api/servers/${server.id}/resources`, { timeoutMs: 20000 });
            if (!data.running) {
                clear(tiles, h('div', { class: 'card' }, offlineNotice(server, 'Sunucu kapalıyken kaynak kullanımı ölçülmez.')));
                tiles.classList.remove('grid-4');
                return;
            }
            tiles.classList.add('grid-4');
            history.cpu.push(data.cpu.percent);
            history.mem.push(data.memory.used);
            if (history.cpu.length > 30) { history.cpu.shift(); history.mem.shift(); }
            let rxRate = null;
            let txRate = null;
            const now = Date.now();
            if (lastNet) {
                const dt = (now - lastNet.at) / 1000;
                rxRate = (data.network.rx - lastNet.rx) / dt;
                txRate = (data.network.tx - lastNet.tx) / dt;
            }
            lastNet = { at: now, rx: data.network.rx, tx: data.network.tx };
            const memPct = data.memory.limit ? data.memory.used / data.memory.limit * 100 : null;
            const cpuMax = (data.cpu.cores || 1) * 100;
            clear(tiles,
                meterTile({ label: 'CPU', iconName: 'cpu', value: `%${data.cpu.percent.toFixed(1)}`, pct: Math.min(100, data.cpu.percent / cpuMax * 100),
                    spark: sparkline(history.cpu, 100), meta: `${data.cpu.cores || '?'} çekirdek paylaşımlı · son ${history.cpu.length} ölçüm` }),
                meterTile({ label: 'Bellek', iconName: 'memory', value: fmtBytes(data.memory.used), pct: data.memory.limited ? memPct : null,
                    spark: sparkline(history.mem), meta: data.memory.limited ? `Limit ${fmtBytes(data.memory.limit)}` : 'Bellek limiti tanımlı değil' }),
                meterTile({ label: 'Disk', iconName: 'hardDrive', value: data.disk ? fmtBytes(data.disk.used) : '—', meta: data.disk ? `cstrike klasörü · ${fmtRelative(data.disk.measuredAt)} ölçüldü` : 'Ölçülemedi' }),
                meterTile({ label: 'Ağ', iconName: 'network', value: rxRate === null ? '…' : fmtRate(rxRate + txRate),
                    meta: rxRate === null ? 'İlk ölçüm alınıyor' : `↓ ${fmtRate(rxRate)} · ↑ ${fmtRate(txRate)}` }));
        } catch (error) {
            clear(tiles, h('div', { class: 'card' }, h('div', { class: 'card-body' }, errorBox(error))));
        }
    }
    function schedule() {
        clearTimeout(timer);
        timer = setTimeout(async () => { if (!document.hidden) await sample(); schedule(); }, 5000);
    }
    onCleanup(() => clearTimeout(timer));

    const steamUrl = `steam://connect/${server.address}`;
    const connection = card({
        title: 'Bağlantı bilgileri', iconName: 'link',
        actions: [linkBtn('Steam ile bağlan', steamUrl, { size: 'sm', variant: 'primary', iconName: 'play' })],
        body: h('dl', { class: 'kv' },
            h('dt', {}, 'Sunucu adresi'), h('dd', {}, copyable(server.address)),
            h('dt', {}, 'Konsol komutu'), h('dd', {}, copyable(`connect ${server.address}`)),
            h('dt', {}, 'FastDL'), h('dd', {}, copyable(server.fastdl.url)),
            h('dt', {}, 'Web sitesi'), h('dd', {}, copyable(server.php.domain ? `http://${server.php.domain}/` : server.php.url)),
            server.sql ? [h('dt', {}, 'Veritabanı'), h('dd', {}, copyable(server.sql.database))] : null)
    });

    const shortcuts = [
        ['console', 'Canlı konsol', 'terminal', 'RCON komutları ve sunucu çıktısı'],
        ['files', 'Dosya yöneticisi', 'folder', 'Yükle, düzenle, ZIP aç'],
        ['plugins', 'Eklentiler', 'puzzle', 'AMX Mod X eklentileri ve derleme'],
        ['website', 'Web sitesi', 'globe', 'PHP siteniz ve alan adı'],
        ['tasks', 'Zamanlanmış görevler', 'calendar', 'Otomatik restart, duyuru, komut'],
        ['settings', 'Ayarlar', 'sliders', 'server.cfg ve başlatma parametreleri']
    ];
    const quick = card({
        title: 'Hızlı erişim', iconName: 'zap', bodyClass: 'tight',
        body: h('div', {}, shortcuts.map(([tab, label, iconName, sub]) => h('a', { class: 'plugin-row link-tile', href: `#/servers/${server.id}/${tab}` },
            icon(iconName), h('div', { class: 'name' }, h('strong', {}, label), h('small', { class: 'small muted' }, ` · ${sub}`)), icon('arrowRight', 'icon-sm'))))
    });

    const runtime = h('dl', { class: 'kv' },
        h('dt', {}, 'Durum'), h('dd', {}, server.statusText || server.state),
        h('dt', {}, 'Port'), h('dd', {}, String(server.port)),
        h('dt', {}, 'Paket'), h('dd', {}, `${server.plan_name} · ${server.maxPlayers} slot`),
        h('dt', {}, 'Harita'), h('dd', {}, server.map || '—'));
    append(panel,
        h('div', { class: 'section-head' }, h('h2', {}, 'Kaynak kullanımı'), h('span', { class: 'small muted' }, '5 saniyede bir güncellenir')),
        tiles,
        h('div', { class: 'grid grid-2 align-start' }, h('div', { class: 'stack' }, connection, card({ title: 'Çalışma bilgisi', iconName: 'activity', body: runtime })), quick));
    sample().then(schedule);
}

// ---------------------------------------------------------------------------
//  Console
// ---------------------------------------------------------------------------

export function consoleTab({ server, panel, onCleanup }) {
    const output = h('div', { class: 'console', role: 'log', 'aria-live': 'polite', tabindex: '0' });
    const statusDot = h('span', { class: 'dot' });
    const statusText = h('span', {}, 'Bağlanıyor…');
    const stateBar = h('div', { class: 'console-state' }, statusDot, statusText);
    const cmd = input({ placeholder: 'Komut yazın (örn. changelevel de_inferno, sv_restart 1)…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Konsol komutu' });
    const history = [];
    let historyIndex = -1;
    let socket = null;
    let closedByUs = false;
    let reconnectTimer = null;
    let retryDelay = 3000;
    const MAX_LINES = 2000;

    function setStatus(kind, text) {
        statusDot.className = `dot dot-${kind}`;
        statusText.textContent = text;
    }

    function line(text, type = '') {
        const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
        output.appendChild(h('div', { class: type ? `line-${type}` : '' }, text));
        while (output.childElementCount > MAX_LINES) output.firstElementChild.remove();
        if (atBottom) output.scrollTop = output.scrollHeight;
    }

    function connect() {
        if (server.state !== 'running') {
            setStatus('offline', 'Sunucu kapalı — başlattığınızda konsol otomatik bağlanır.');
            return;
        }
        setStatus('starting', 'Bağlanıyor…');
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${proto}//${window.location.host}/?containerId=${enc(server.id)}`);
        socket.onopen = () => { retryDelay = 3000; setStatus('online', 'Bağlı · çıktı canlı akıyor'); };
        socket.onmessage = event => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            if (msg.type === 'log') line(msg.data);
            else if (msg.type === 'rcon_response') line(msg.data || '(yanıt yok)', 'system');
            else if (msg.type === 'error') line(msg.data, 'error');
            else if (msg.type === 'status') line('— Sunucu çıktısı sona erdi (sunucu durdu veya yeniden başlıyor) —', 'system');
        };
        socket.onclose = () => {
            if (closedByUs) return;
            const s = (state.servers || []).find(x => x.id === server.id);
            if (s && s.state !== 'running') {
                setStatus('offline', 'Sunucu kapalı — başlattığınızda konsol otomatik bağlanır.');
                return;
            }
            setStatus('starting', `Bağlantı kesildi; ${Math.round(retryDelay / 1000)} sn içinde yeniden denenecek.`);
            reconnectTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 60000);
        };
    }

    function send(command) {
        if (!command) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) return toast('Konsol bağlantısı hazır değil.', 'warning');
        line(`] ${command}`, 'command');
        socket.send(JSON.stringify({ type: 'command', data: command }));
        if (history[0] !== command) history.unshift(command);
        history.length = Math.min(history.length, 50);
        historyIndex = -1;
    }

    cmd.addEventListener('keydown', e => {
        if (e.key === 'ArrowUp' && history.length) { e.preventDefault(); historyIndex = Math.min(historyIndex + 1, history.length - 1); cmd.value = history[historyIndex]; }
        if (e.key === 'ArrowDown') { e.preventDefault(); historyIndex = Math.max(historyIndex - 1, -1); cmd.value = historyIndex >= 0 ? history[historyIndex] : ''; }
    });
    const form = h('form', { class: 'console-input', onSubmit: e => { e.preventDefault(); send(cmd.value.trim()); cmd.value = ''; } },
        h('span', { class: 'prompt' }, '>'), cmd, btn('Gönder', { variant: 'primary', type: 'submit', iconName: 'send' }));
    const quick = ['status', 'stats', 'sv_restart 1', 'amx_reloadadmins', 'amx_plugins', 'maps *'];

    panel.appendChild(card({
        title: 'Canlı konsol', iconName: 'terminal', sub: 'Sunucu çıktısı canlı akar; komutlar RCON ile gönderilir. ↑/↓ ile geçmiş komutlar.',
        actions: [
            btn('Kopyala', { iconName: 'copy', onClick: () => copyText(output.innerText || '') }),
            btn('Temizle', { variant: 'ghost', iconName: 'trash', onClick: () => clear(output) })
        ],
        bodyClass: 'tight',
        body: [stateBar, output, form, h('div', { class: 'chips chips-bar' }, quick.map(q => h('button', { class: 'chip mono', type: 'button', onClick: () => send(q) }, q)))]
    }));
    connect();
    onCleanup(() => { closedByUs = true; clearTimeout(reconnectTimer); if (socket) socket.close(); });
    setTimeout(() => cmd.focus(), 50);
}

// ---------------------------------------------------------------------------
//  Logs: live output, chat history, log files, crash reports
// ---------------------------------------------------------------------------

export function logsTab({ server, panel, onCleanup }) {
    const MODES = [['live', 'Canlı log'], ['chat', 'Sohbet'], ['files', 'Log dosyaları'], ['crash', 'Çökme raporları']];
    let mode = 'live';
    const seg = h('div', { class: 'segmented', role: 'tablist' });
    const tools = h('div', { class: 'fm-toolbar' });
    const body = h('div');
    const cardEl = card({ title: 'Loglar ve tanılama', iconName: 'list', actions: [seg], bodyClass: 'tight', body: [tools, body] });
    let liveTimer = null;
    onCleanup(() => clearInterval(liveTimer));

    function paintSeg() {
        clear(seg, MODES.map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': mode === id ? 'true' : 'false', class: mode === id ? 'active' : '', onClick: () => { mode = id; paintSeg(); show(); } }, label)));
    }

    function show() {
        clearInterval(liveTimer);
        clear(tools);
        clear(body, loading());
        ({ live: showLive, chat: showChat, files: showFiles, crash: showCrash })[mode]();
    }

    // -- live container output
    function showLive() {
        let raw = '';
        const tail = select([{ value: '200', label: 'Son 200 satır' }, { value: '1000', label: 'Son 1000 satır' }, { value: '5000', label: 'Son 5000 satır' }], { value: '1000', 'aria-label': 'Satır sayısı' });
        const search = searchInput({ placeholder: 'Loglarda ara…', onSearch: paint });
        const follow = switchControl('Canlı takip', false, on => {
            clearInterval(liveTimer);
            if (on) liveTimer = setInterval(() => { if (!document.hidden) load(true); }, 5000);
        });
        const pre = h('pre', { class: 'log-box' });
        function paint() {
            const term = search.control.value.trim().toLowerCase();
            const lines = raw.split('\n');
            const shown = term ? lines.filter(l => l.toLowerCase().includes(term)) : lines;
            pre.textContent = shown.join('\n') || (term ? 'Eşleşen satır yok.' : 'Kayıt yok.');
            pre.scrollTop = pre.scrollHeight;
        }
        async function load(quiet = false) {
            if (!quiet) clear(body, loading());
            try {
                const data = await api(`/api/servers/${server.id}/logs?tail=${tail.value}`);
                raw = data.logs || '';
                paint();
                if (!quiet) clear(body, pre);
            } catch (error) { if (!quiet) clear(body, h('div', { class: 'card-body' }, errorBox(error))); }
        }
        tail.addEventListener('change', () => load());
        append(tools, search, tail, follow, h('span', { class: 'spacer' }),
            btn('İndir', { size: 'sm', iconName: 'download', onClick: () => saveBlob(new Blob([raw], { type: 'text/plain' }), `${server.port}-console.log`) }),
            refreshBtn(() => load()));
        load();
    }

    // -- chat history from cstrike/logs
    function showChat() {
        let messages = [];
        let files = [];
        const fileSel = select([{ value: '', label: 'Son log dosyaları' }], { 'aria-label': 'Log dosyası' });
        const channel = select([{ value: '', label: 'Tüm kanallar' }, { value: 'all', label: 'Genel sohbet' }, { value: 'team', label: 'Takım sohbeti' }], { 'aria-label': 'Kanal' });
        const search = searchInput({ placeholder: 'Mesaj, oyuncu veya SteamID…', onSearch: paint });
        const list = h('div');
        function paint() {
            const term = search.control.value.trim();
            const rows = filterRows(messages.filter(m => !channel.value || m.channel === channel.value), term, ['message', 'name', 'steamId']);
            if (!rows.length) {
                clear(list, emptyState({ iconName: 'chat', title: messages.length ? 'Eşleşen mesaj yok' : 'Sohbet kaydı bulunamadı', text: messages.length ? 'Arama veya filtreyi değiştirin.' : 'Oyun içi mesajlar sunucu loglarından okunur (log on). Oyuncular yazdıkça burada görünür.' }));
                return;
            }
            clear(list, rows.slice(0, 500).map(m => h('div', { class: 'chat-line' },
                h('time', { datetime: m.time, title: fmtDateTime(m.time) }, m.time.slice(11, 16)),
                h('button', { type: 'button', class: `who ${m.team === 'CT' ? 'team-ct' : m.team === 'TERRORIST' ? 'team-t' : ''}`, title: `${m.steamId} · işlem için tıklayın`, onClick: () => playerMenu(m) }, m.name),
                h('span', { class: 'msg' }, m.channel === 'team' ? badge('Takım', 'info') : null, m.dead ? badge('Ölü') : null, m.message))));
        }
        function playerMenu(m) {
            const modal = openModal({
                title: m.name,
                body: h('dl', { class: 'kv' }, h('dt', {}, 'SteamID'), h('dd', {}, copyable(m.steamId)), h('dt', {}, 'Takım'), h('dd', {}, m.team || '—'), h('dt', {}, 'Mesaj'), h('dd', {}, m.message)),
                footer: [
                    btn('Bu oyuncunun mesajları', { variant: 'ghost', onClick: () => { search.control.value = m.steamId; paint(); modal.close(); } }),
                    /^STEAM_/.test(m.steamId) ? btn('Yasakla', { variant: 'danger', iconName: 'lock', onClick: async () => {
                        modal.close();
                        const ok = await banDialog(server, { target: m.steamId, name: m.name });
                        if (ok) toast('Yasak eklendi.', 'success');
                    } }) : null
                ]
            });
        }
        async function load() {
            clear(list, loading());
            try {
                const params = new URLSearchParams({ limit: '1000' });
                if (fileSel.value) params.set('file', fileSel.value);
                const data = await api(`/api/servers/${server.id}/chat?${params}`, { timeoutMs: 40000 });
                messages = data.messages || [];
                if (!files.length && data.files && data.files.length) {
                    files = data.files;
                    const current = fileSel.value;
                    clear(fileSel, h('option', { value: '' }, 'Son log dosyaları'), files.map(f => h('option', { value: f }, f)));
                    fileSel.value = current;
                }
                paint();
            } catch (error) { clear(list, h('div', { class: 'card-body' }, errorBox(error))); }
        }
        fileSel.addEventListener('change', load);
        channel.addEventListener('change', paint);
        append(tools, search, channel, fileSel, h('span', { class: 'spacer' }), refreshBtn(load));
        clear(body, list);
        load();
    }

    // -- raw log files
    function showFiles() {
        async function load() {
            clear(body, loading());
            try {
                const data = await api(`/api/servers/${server.id}/logfiles`);
                clear(body, table([
                    { label: 'Dosya', key: 'name', type: 'mono', sort: f => f.name },
                    { label: 'Tarih', type: 'date', render: f => fmtDateTime(f.modified), sort: f => f.modified },
                    { label: 'Boyut', type: 'num', render: f => fmtBytes(f.size), sort: f => f.size },
                    { label: '', type: 'actions', render: f => tableActions(btn('İndir', { size: 'xs', iconName: 'download', onClick: e => withBusy(e.currentTarget, () => downloadFile(`/api/servers/${server.id}/logfiles/download?file=${enc(f.name)}`, f.name).catch(toastError)) })) }
                ], data.files || [], { empty: 'cstrike/logs klasöründe log dosyası yok.', scrollY: true }));
            } catch (error) { clear(body, h('div', { class: 'card-body' }, errorBox(error))); }
        }
        append(tools, h('span', { class: 'small muted' }, 'HLDS oyun logları (cstrike/logs). En yeni dosya en üstte.'), h('span', { class: 'spacer' }), refreshBtn(load));
        load();
    }

    // -- crash reports
    function showCrash() {
        async function load() {
            clear(body, loading());
            try {
                const data = await api(`/api/servers/${server.id}/crash-logs`);
                const block = (title, text, okText) => h('div', { class: 'stack stack-sm' },
                    h('div', { class: 'row row-sm' }, h('h3', {}, title), text ? badge('Kayıt var', 'danger') : badge('Temiz', 'success')),
                    h('pre', { class: 'log-box short' }, text || okText));
                clear(body, h('div', { class: 'card-body stack' },
                    block('Motor hataları (sys_error.log)', data.sys_error, 'Motor hatası kaydı yok.'),
                    block('Çökme dökümü (debug.log)', data.debug_log, 'Çökme dökümü yok.'),
                    block(`AMX Mod X hataları${data.amxx_file ? ` (${data.amxx_file})` : ''}`, data.amxx_errors, 'Eklenti hatası yok.')));
            } catch (error) { clear(body, h('div', { class: 'card-body' }, errorBox(error))); }
        }
        append(tools, h('span', { class: 'small muted' }, 'Sunucu çöktüğünde veya eklenti hata verdiğinde kayıtlar burada görünür.'), h('span', { class: 'spacer' }), refreshBtn(load));
        load();
    }

    paintSeg();
    panel.appendChild(cardEl);
    show();
}

// ---------------------------------------------------------------------------
//  Files
// ---------------------------------------------------------------------------

export function filesTab({ server, panel, onCleanup }) {
    const base = `/api/files/${server.id}`;
    if (server.state !== 'running') {
        panel.appendChild(card({ title: 'Dosya yöneticisi', iconName: 'folder', body: offlineNotice(server, 'Dosya işlemleri sunucu konteyneri üzerinden yapılır; önce sunucuyu başlatın.') }));
        return;
    }
    const fm = createFileManager({
        rootLabel: 'cstrike',
        list: path => api(`${base}/list?path=${enc(path)}`),
        view: file => api(`${base}/view?file=${enc(file)}`).then(d => d.content),
        save: (file, content) => api(`${base}/edit`, { method: 'POST', body: { file, content } }),
        remove: path => api(`${base}?file=${enc(path)}`, { method: 'DELETE' }),
        mkdir: (path, name) => api(`${base}/mkdir`, { method: 'POST', body: { path, name } }),
        rename: (from, to) => api(`${base}/rename`, { method: 'POST', body: { from, to } }),
        extract: (file, dest) => api(`${base}/extract`, { method: 'POST', body: { file, dest }, timeoutMs: 300000 }),
        downloadUrl: path => `${base}/download?file=${enc(path)}`,
        uploadUrl: `${base}/upload`,
        uploadFolderUrl: `${base}/upload-folder`,
        processingMessage: 'Dosyalar atomik olarak yazılıyor; harita/model/ses dosyaları FastDL ile eşitleniyor.'
    });
    onCleanup(() => fm.abort());
    panel.appendChild(card({
        title: 'Dosya yöneticisi', iconName: 'folder',
        sub: 'Dosyaları sürükleyip bırakarak yükleyebilir, .zip arşivlerini sunucuda açabilirsiniz.',
        bodyClass: 'tight', body: fm.el
    }));
}

// ---------------------------------------------------------------------------
//  Plugins
// ---------------------------------------------------------------------------

export function pluginsTab({ server, panel }) {
    const listBox = h('div', {}, loading());
    const smaSelect = select([{ value: '', label: 'Kaynak dosya seçin…' }]);
    const output = h('pre', { class: 'log-box short', hidden: true });
    const progress = h('div', { hidden: true });
    const search = searchInput({ placeholder: 'Eklenti ara…', onSearch: () => paint() });
    let plugins = [];

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/plugins/${server.id}`);
            if (data.offline) { clear(listBox, offlineNotice(server)); return; }
            plugins = data.plugins;
            clear(smaSelect, h('option', { value: '' }, data.sourceFiles.length ? 'Kaynak dosya seçin…' : 'scripting klasöründe .sma yok'), data.sourceFiles.map(f => h('option', { value: f }, f)));
            paint();
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function saveOrder(order) {
        try {
            await api(`/api/plugins/${server.id}/order`, { method: 'POST', body: { orderedFilenames: order } });
            toast('Eklenti sırası kaydedildi. Harita değişiminde geçerli olur.', 'success', 2000);
            load();
        } catch (error) { toastError(error); }
    }

    function move(index, dir) {
        const order = plugins.map(p => p.filename);
        const target = index + dir;
        if (target < 0 || target >= order.length) return;
        [order[index], order[target]] = [order[target], order[index]];
        saveOrder(order);
    }

    function paint() {
        if (!plugins.length) { clear(listBox, emptyState({ iconName: 'puzzle', title: 'Eklenti bulunamadı', text: 'plugins.ini boş ve plugins klasöründe .amxx dosyası yok.' })); return; }
        const term = search.control.value.trim().toLowerCase();
        const rows = plugins.map((p, i) => ({ p, i })).filter(({ p }) => !term || `${p.filename} ${p.description || ''}`.toLowerCase().includes(term));
        if (!rows.length) { clear(listBox, h('div', { class: 'table-empty' }, 'Eşleşen eklenti yok.')); return; }
        clear(listBox, rows.map(({ p, i }) => h('div', { class: 'plugin-row' },
            h('span', { class: 'order' }, String(i + 1)),
            h('div', { class: 'name' }, h('code', {}, p.filename), h('small', {}, p.inIni ? (p.description || 'plugins.ini') : 'plugins.ini dosyasında yok')),
            switchControl(h('span', { class: 'sr-only' }, `${p.filename} etkin`), p.enabled, async (checked, el) => {
                try {
                    await api(`/api/plugins/${server.id}/toggle`, { method: 'POST', body: { filename: p.filename, enable: checked } });
                    toast(`${p.filename} ${checked ? 'etkinleştirildi' : 'devre dışı bırakıldı'}. Değişiklik harita değişiminde geçerli olur.`, 'success', 2500);
                    load();
                } catch (error) { el.checked = !checked; toastError(error); }
            }),
            tableActions(
                btn(null, { size: 'xs', variant: 'ghost', iconName: 'arrowUp', title: 'Yukarı taşı', disabled: i === 0 || !!term, onClick: () => move(i, -1) }),
                btn(null, { size: 'xs', variant: 'ghost', iconName: 'arrowDown', title: 'Aşağı taşı', disabled: i === plugins.length - 1 || !!term, onClick: () => move(i, 1) })))));
    }

    const fileInput = h('input', { type: 'file', accept: '.sma,.amxx', class: 'input' });
    const addIni = h('input', { type: 'checkbox', checked: true });
    const uploadBtn = btn('Yükle', { variant: 'primary', iconName: 'upload' });
    uploadBtn.addEventListener('click', () => withBusy(uploadBtn, async () => {
        if (!fileInput.files.length) return toast('Bir .sma veya .amxx dosyası seçin.', 'warning');
        const form = new FormData();
        form.append('addToIni', addIni.checked ? 'true' : 'false');
        form.append('file', fileInput.files[0]);
        try {
            const data = await uploadWithBar(progress, `/api/plugins/${server.id}/upload`, form, fileInput.files[0].name);
            toast(data.message, 'success');
            fileInput.value = '';
            load();
        } catch (error) { toastError(error); }
    }));

    const compileIni = h('input', { type: 'checkbox', checked: true });
    const compileBtn = btn('Derle', { variant: 'primary', iconName: 'zap' });
    compileBtn.addEventListener('click', () => withBusy(compileBtn, async () => {
        if (!smaSelect.value) return toast('Derlenecek .sma dosyasını seçin.', 'warning');
        output.hidden = false;
        output.className = 'log-box short';
        output.textContent = 'Derleniyor…';
        try {
            const data = await api(`/api/plugins/${server.id}/compile`, { method: 'POST', body: { filename: smaSelect.value, addToIni: compileIni.checked }, timeoutMs: 90000 });
            output.textContent = data.output || data.message;
            output.classList.add(data.success ? 'text-success' : 'text-danger');
            toast(data.message, data.success ? 'success' : 'error');
            if (data.success) load();
        } catch (error) { output.textContent = error.message; output.classList.add('text-danger'); }
    }));

    panel.appendChild(h('div', { class: 'grid grid-aside' },
        card({ title: 'Eklenti sırası (plugins.ini)', iconName: 'puzzle', sub: 'Sıra, eklentilerin yüklenme önceliğidir.', actions: [search, refreshBtn(load)], bodyClass: 'tight', body: listBox }),
        h('div', { class: 'stack' },
            card({ title: 'Eklenti yükle', iconName: 'upload', body: h('div', { class: 'form-stack' }, field('.sma veya .amxx dosyası', fileInput), h('label', { class: 'check' }, addIni, '.amxx dosyasını plugins.ini dosyasına ekle'), progress, uploadBtn) }),
            card({ title: 'Kaynak derle (.sma → .amxx)', iconName: 'zap', body: h('div', { class: 'form-stack' }, field('Kaynak dosya', smaSelect), h('label', { class: 'check' }, compileIni, 'Derlenen eklentiyi plugins.ini dosyasına ekle'), compileBtn, output) }))));
    load();
}

// ---------------------------------------------------------------------------
//  Maps
// ---------------------------------------------------------------------------

export function mapsTab({ server, panel }) {
    const listBox = h('div', {}, loading());
    const cycle = h('textarea', { class: 'textarea code', rows: 16, spellcheck: 'false', 'aria-label': 'mapcycle.txt' });
    const progress = h('div', { hidden: true });
    const search = searchInput({ placeholder: 'Harita ara…', onSearch: () => paint() });
    let data = { maps: [], mapcycle: [] };

    function paint() {
        const rows = filterRows(data.maps, search.control.value.trim(), ['name']);
        clear(listBox, table([
            { label: 'Harita', key: 'name', type: 'mono', sort: m => m.name },
            { label: 'Boyut', type: 'num', render: m => fmtBytes(m.size), sort: m => m.size, hideSm: true },
            { label: 'Döngüde', render: m => (data.mapcycle.includes(m.name) ? badge('Evet', 'success') : badge('Hayır')), sort: m => (data.mapcycle.includes(m.name) ? 0 : 1) },
            { label: '', type: 'actions', render: m => tableActions(
                btn('Geç', { size: 'xs', iconName: 'play', title: 'Bu haritaya geç', disabled: server.state !== 'running', onClick: async () => {
                    if (!(await confirmDialog({ title: 'Harita değiştir', message: `Sunucu "${m.name}" haritasına geçecek. Oyuncular yeniden bağlanır.`, confirmText: 'Haritayı değiştir' }))) return;
                    try { await api(`/api/servers/${server.id}/settings`, { method: 'POST', body: { map: m.name } }); toast('Harita değiştiriliyor.', 'success'); } catch (error) { toastError(error); }
                } }),
                btn(null, { size: 'xs', iconName: 'trash', variant: 'danger', title: 'Sil', onClick: async () => {
                    if (!(await confirmDialog({ title: 'Harita silinsin mi?', message: `${m.filename} sunucudan ve FastDL'den silinecek.`, confirmText: 'Sil', danger: true }))) return;
                    try { await api(`/api/maps/${server.id}?filename=${enc(m.filename)}`, { method: 'DELETE' }); toast('Harita silindi.', 'success'); load(); } catch (error) { toastError(error); }
                } })) }
        ], rows, { empty: data.maps.length ? 'Eşleşen harita yok.' : 'maps klasöründe .bsp dosyası yok.', scrollY: true, initialSort: { key: 'name', dir: 'asc' } }));
    }

    async function load() {
        clear(listBox, loading());
        try {
            data = await api(`/api/maps/${server.id}`);
            if (data.offline) { clear(listBox, offlineNotice(server)); return; }
            cycle.value = data.mapcycle.join('\n');
            paint();
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const fileInput = h('input', { type: 'file', accept: '.bsp', class: 'input' });
    const addCycle = h('input', { type: 'checkbox', checked: true });
    const uploadBtn = btn('Haritayı yükle', { variant: 'primary', iconName: 'upload' });
    uploadBtn.addEventListener('click', () => withBusy(uploadBtn, async () => {
        if (!fileInput.files.length) return toast('Bir .bsp dosyası seçin.', 'warning');
        const form = new FormData();
        form.append('addToCycle', addCycle.checked ? 'true' : 'false');
        form.append('file', fileInput.files[0]);
        try {
            const res = await uploadWithBar(progress, `/api/maps/${server.id}/upload`, form, fileInput.files[0].name);
            toast(res.warning ? `Yüklendi; FastDL uyarısı: ${res.warning}` : res.message, res.warning ? 'warning' : 'success');
            fileInput.value = '';
            load();
        } catch (error) { toastError(error); }
    }));
    const saveCycle = btn('Kaydet', { variant: 'primary', iconName: 'check' });
    saveCycle.addEventListener('click', () => withBusy(saveCycle, async () => {
        const list = cycle.value.split('\n').map(s => s.trim()).filter(Boolean);
        const installed = new Set(data.maps.map(m => m.name));
        const missing = list.filter(m => !installed.has(m));
        if (missing.length && !(await confirmDialog({ title: 'Yüklü olmayan haritalar', message: `Şu haritalar sunucuda yok; döngü bu haritalara geldiğinde sunucu bir sonrakine atlar:\n\n${missing.join(', ')}\n\nYine de kaydedilsin mi?`, confirmText: 'Yine de kaydet' }))) return;
        try {
            await api(`/api/maps/${server.id}/mapcycle`, { method: 'POST', body: { mapcycle: list } });
            toast('mapcycle.txt kaydedildi.', 'success');
            load();
        } catch (error) { toastError(error); }
    }));

    panel.appendChild(h('div', { class: 'grid grid-aside' },
        card({ title: 'Yüklü haritalar', iconName: 'map', actions: [search, refreshBtn(load)], bodyClass: 'tight', body: listBox }),
        h('div', { class: 'stack' },
            card({ title: 'Harita yükle', iconName: 'upload', sub: 'Yüklenen harita otomatik olarak FastDL ile eşitlenir.', body: h('div', { class: 'form-stack' }, field('.bsp dosyası', fileInput), h('label', { class: 'check' }, addCycle, 'Harita döngüsüne ekle'), progress, uploadBtn) }),
            card({ title: 'Harita döngüsü', iconName: 'refresh', sub: 'Her satıra bir harita (mapcycle.txt).', actions: [saveCycle], body: cycle }))));
    load();
}

// ---------------------------------------------------------------------------
//  Players
// ---------------------------------------------------------------------------

export function playersTab({ server, panel, onCleanup }) {
    const live = h('div', {}, loading());
    const board = h('div', {}, loading());
    const historyBox = h('div', {}, loading());
    const updated = h('span', { class: 'small muted' });
    let timer = null;
    onCleanup(() => clearInterval(timer));

    async function action(name, kind) {
        let reason = '';
        let duration = 0;
        if (kind === 'kick' || kind === 'ban') {
            const values = await formDialog({
                title: kind === 'kick' ? `${name} — at` : `${name} — yasakla`,
                fields: [
                    kind === 'ban' ? { name: 'duration', label: 'Süre (dakika, 0 = kalıcı)', type: 'number', value: '60', min: 0, max: 525600 } : null,
                    { name: 'reason', label: 'Sebep', value: kind === 'kick' ? 'Kurallara uymama' : 'Kural ihlali', full: true, maxlength: 100 }
                ].filter(Boolean),
                submitText: kind === 'kick' ? 'At' : 'Yasakla',
                danger: true
            });
            if (!values) return;
            reason = values.reason;
            duration = parseInt(values.duration || '0', 10) || 0;
        } else if (!(await confirmDialog({ title: kind === 'slap' ? 'Tokatla' : 'Öldür', message: `${name} oyuncusuna "${kind === 'slap' ? 'tokat' : 'öldürme'}" komutu gönderilsin mi?`, confirmText: 'Gönder' }))) return;
        try {
            const data = await api(`/api/players/${server.id}/action`, { method: 'POST', body: { action: kind, name, reason, duration } });
            toast(data.response ? String(data.response).slice(0, 200) : 'Komut gönderildi.', 'success');
            setTimeout(() => loadLive(true), 800);
        } catch (error) { toastError(error); }
    }

    async function loadLive(quiet = false) {
        if (server.state !== 'running') { clear(live, offlineNotice(server)); return; }
        if (!quiet) clear(live, loading());
        try {
            const data = await api(`/api/players/${server.id}`);
            updated.textContent = `Güncellendi ${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
            clear(live, table([
                { label: 'Oyuncu', render: p => h('strong', {}, p.name), sort: p => p.name.toLowerCase() },
                { label: 'Skor', type: 'num', key: 'frags', sort: p => Number(p.frags) || 0 },
                { label: 'Süre', type: 'date', key: 'time' },
                { label: '', type: 'actions', render: p => tableActions(
                    btn('At', { size: 'xs', variant: 'danger', onClick: () => action(p.name, 'kick') }),
                    btn('Yasakla', { size: 'xs', variant: 'danger', onClick: () => action(p.name, 'ban') }),
                    moreMenu(close => [
                        menuItem('Tokatla', () => { close(); action(p.name, 'slap'); }, { iconName: 'zap' }),
                        menuItem('Öldür', () => { close(); action(p.name, 'slay'); }, { iconName: 'crosshair' })
                    ])) }
            ], data.players || [], { empty: 'Şu anda sunucuda oyuncu yok.', initialSort: { key: 'frags', dir: 'desc' } }));
        } catch (error) { if (!quiet) clear(live, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadBoard() {
        try {
            const data = await api(`/api/players/${server.id}/stats`);
            if (!data.enabled) {
                clear(board, h('div', { class: 'card-body' }, h('p', { class: 'text-2' }, data.message || 'İstatistik tablosu bulunamadı.'),
                    h('p', { class: 'small muted mt-2' }, 'csstats_mysql / statsx_sql eklentisini etkinleştirdiğinizde sıralama burada görünür. Veritabanı bilgileri sql.cfg dosyasına otomatik yazılır.')));
                return;
            }
            clear(board, table([
                { label: '#', type: 'num', key: 'rank' },
                { label: 'Oyuncu', render: s => h('strong', {}, s.name) },
                { label: 'Öldürme', type: 'num', key: 'kills', sort: s => s.kills },
                { label: 'Ölüm', type: 'num', key: 'deaths', sort: s => s.deaths, hideSm: true },
                { label: 'K/D', type: 'num', key: 'kd', sort: s => Number(s.kd) },
                { label: 'Kafadan', type: 'num', key: 'hs', hideSm: true },
                { label: 'İsabet', type: 'num', key: 'accuracy', hideSm: true }
            ], data.stats || [], { empty: 'Henüz istatistik yok.', scrollY: true }));
        } catch (error) { clear(board, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadHistory() {
        try {
            const data = await api(`/api/players/${server.id}/history`);
            clear(historyBox, table([
                { label: 'Oyuncu', render: r => h('strong', {}, r.name) },
                { label: 'SteamID', key: 'steamid', type: 'mono' },
                { label: 'Son görülme', type: 'date', key: 'lastSeen' },
                { label: '', type: 'actions', render: r => (/^STEAM_/.test(r.steamid) ? btn(null, { size: 'xs', variant: 'ghost', iconName: 'lock', title: 'SteamID ile yasakla', onClick: async () => {
                    const ok = await banDialog(server, { target: r.steamid, name: r.name });
                    if (ok) toast('Yasak eklendi.', 'success');
                } }) : null) }
            ], data.history || [], { empty: 'Bağlantı geçmişi bulunamadı (loglama açık olmalı).', scrollY: true }));
        } catch (error) { clear(historyBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    append(panel,
        card({ title: 'Oyundaki oyuncular', iconName: 'users', sub: '10 saniyede bir otomatik yenilenir.', actions: [updated, refreshBtn(() => loadLive())], bodyClass: 'tight', body: live }),
        h('div', { class: 'grid grid-2' },
            card({ title: 'Sıralama (MySQL)', iconName: 'activity', bodyClass: 'tight', body: board }),
            card({ title: 'Son bağlananlar', iconName: 'clock', bodyClass: 'tight', body: historyBox })));
    loadLive();
    loadBoard();
    loadHistory();
    if (server.state === 'running') timer = setInterval(() => { if (!document.hidden) loadLive(true); }, 10000);
}

// ---------------------------------------------------------------------------
//  Admins & bans
// ---------------------------------------------------------------------------

const ADMIN_TYPES = [{ value: 'ce', label: 'SteamID (şifresiz)' }, { value: 'a', label: 'Nick + şifre' }, { value: 'de', label: 'IP adresi' }];

export function adminsTab({ server, panel }) {
    const adminsBox = h('div', {}, loading());
    const bansBox = h('div', {}, loading());
    const banSearch = searchInput({ placeholder: 'SteamID / IP ara…', onSearch: () => paintBans() });
    let bans = [];

    function paintBans() {
        const rows = filterRows(bans, banSearch.control.value.trim(), [b => b.steamId, b => b.ip]);
        clear(bansBox, table([
            { label: 'Hedef', type: 'mono', render: b => (b.type === 'IP' ? b.ip : b.steamId) },
            { label: 'Tür', key: 'type' },
            { label: 'Süre', render: b => (Number(b.duration) === 0 ? badge('Kalıcı', 'danger') : `${b.duration} dk`) },
            { label: '', type: 'actions', render: b => btn('Kaldır', { size: 'xs', onClick: async () => {
                const target = b.type === 'IP' ? b.ip : b.steamId;
                if (!(await confirmDialog({ title: 'Yasak kaldırılsın mı?', message: `${target} için yasak kaldırılacak; oyuncu sunucuya tekrar girebilir.`, confirmText: 'Yasağı kaldır' }))) return;
                try { await api(`/api/admins/${server.id}/unban`, { method: 'POST', body: { target, isIp: b.type === 'IP' } }); toast('Yasak kaldırıldı.', 'success'); load(); } catch (error) { toastError(error); }
            } }) }
        ], rows, { empty: bans.length ? 'Eşleşen yasak yok.' : 'Kayıtlı yasak yok.', scrollY: true }));
    }

    function adminForm(existing = null) {
        const comment = existing && existing.raw.includes(';') ? existing.raw.split(';').slice(1).join(';').trim() : '';
        const type = existing ? (existing.flags.includes('c') ? 'ce' : existing.flags.includes('d') ? 'de' : 'a') : 'ce';
        return formDialog({
            title: existing ? `Yetkiliyi düzenle · ${existing.auth}` : 'Yetkili ekle',
            fields: [
                { name: 'type', label: 'Giriş tipi', type: 'select', value: type, options: ADMIN_TYPES },
                { name: 'auth', label: 'SteamID / Nick / IP', value: existing ? existing.auth : '', placeholder: 'STEAM_0:1:12345', required: true, code: true,
                    validate: (v, values) => (values.type === 'ce' && !validators.steamId(v.trim()) ? 'SteamID STEAM_0:X:XXXX biçiminde olmalı.'
                        : values.type === 'de' && !validators.ip(v.trim()) ? 'Geçerli bir IPv4 adresi girin.' : null) },
                { name: 'password', label: 'Şifre', placeholder: 'setinfo _pw ile kullanılır', showIf: v => v.type === 'a', required: !existing },
                { name: 'access', label: 'Yetki bayrakları', value: existing ? existing.access : 'abcdefghijklmnopqrstu', required: true, code: true,
                    help: 'Tam yetki: abcdefghijklmnopqrstu · Sadece kick/ban: bcd', validate: v => (/^[a-z]+$/.test(v.trim()) ? null : 'Yalnızca küçük harf bayraklar (a-z).') },
                { name: 'comment', label: 'Not', value: comment, placeholder: 'Örn. Kurucu', full: true, maxlength: 100 }
            ],
            submitText: existing ? 'Kaydet' : 'Ekle',
            onSubmit: async values => {
                const body = { auth: values.auth.trim(), password: values.type === 'a' ? values.password : '', access: values.access.trim(), flags: values.type, comment: values.comment };
                if (existing) {
                    if (values.type === 'a' && !values.password) throw new Error('Nick girişli yetkili için şifre girin (mevcut şifre okunamaz).');
                    await api(`/api/admins/${server.id}/delete`, { method: 'POST', body: { auth: existing.auth } });
                }
                return api(`/api/admins/${server.id}/add`, { method: 'POST', body });
            }
        }).then(result => { if (result) { toast(existing ? 'Yetkili güncellendi.' : 'Yetkili eklendi ve yeniden yüklendi.', 'success'); load(); } });
    }

    async function load() {
        try {
            const data = await api(`/api/admins/${server.id}`);
            if (data.offline) { clear(adminsBox, offlineNotice(server)); clear(bansBox); return; }
            clear(adminsBox, table([
                { label: 'Kimlik', key: 'auth', type: 'mono', sort: a => a.auth.toLowerCase() },
                { label: 'Yetkiler', key: 'access', type: 'mono' },
                { label: 'Giriş', render: a => (a.flags.includes('c') ? 'SteamID' : a.flags.includes('d') ? 'IP' : 'Nick + şifre'), hideSm: true },
                { label: 'Not', render: a => (a.raw.includes(';') ? h('span', { class: 'small muted' }, a.raw.split(';').slice(1).join(';').trim()) : null), hideSm: true },
                { label: '', type: 'actions', render: a => tableActions(
                    btn(null, { size: 'xs', variant: 'ghost', iconName: 'edit', title: 'Düzenle', onClick: () => adminForm(a) }),
                    btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Kaldır', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Yetkili kaldırılsın mı?', message: `${a.auth} users.ini dosyasından silinecek.`, confirmText: 'Kaldır', danger: true }))) return;
                        try { await api(`/api/admins/${server.id}/delete`, { method: 'POST', body: { auth: a.auth } }); toast('Yetkili kaldırıldı.', 'success'); load(); } catch (error) { toastError(error); }
                    } })) }
            ], data.admins, { empty: 'users.ini dosyasında yetkili yok.' }));
            bans = data.bans || [];
            paintBans();
        } catch (error) { clear(adminsBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    panel.appendChild(h('div', { class: 'grid grid-2' },
        card({ title: 'Yetkililer (users.ini)', iconName: 'shield', actions: [btn('Yetkili ekle', { variant: 'primary', iconName: 'plus', onClick: () => adminForm() })], bodyClass: 'tight', body: adminsBox }),
        card({ title: 'Yasaklar', iconName: 'lock', actions: [banSearch, btn('Yasak ekle', { variant: 'primary', iconName: 'plus', onClick: () => banDialog(server).then(ok => { if (ok) { toast('Yasak eklendi.', 'success'); load(); } }) })], bodyClass: 'tight', body: bansBox })));
    load();
}

// ---------------------------------------------------------------------------
//  Website (PHP)
// ---------------------------------------------------------------------------

export async function websiteTab({ server, panel, onCleanup }) {
    panel.appendChild(loading());
    let info;
    try { info = await api(`/api/sites/${server.id}`); } catch (error) { clear(panel, errorBox(error)); return; }
    clear(panel);
    const base = `/api/sites/${server.id}`;
    const urlFor = path => {
        const root = info.domainUrl || info.url;
        return `${root}${path.split('/').map(enc).join('/')}`;
    };

    const domainInput = input({ value: info.domain || '', placeholder: 'www.sunucum.com', autocomplete: 'off', 'aria-label': 'Alan adı' });
    const domainError = h('div', { class: 'field-error', hidden: true });
    const saveDomain = btn('Kaydet', { variant: 'primary' });
    saveDomain.addEventListener('click', () => withBusy(saveDomain, async () => {
        const value = domainInput.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        domainError.hidden = true;
        if (value && !validators.domain(value)) { domainError.textContent = 'Geçerli bir alan adı girin (örn. www.sunucum.com).'; domainError.hidden = false; return; }
        if (!value && info.domain && !(await confirmDialog({ title: 'Alan adı kaldırılsın mı?', message: `${info.domain} bu siteden ayrılacak.`, confirmText: 'Kaldır', danger: true }))) return;
        try {
            const data = await api(`${base}/domain`, { method: 'PUT', body: { domain: value } });
            info = data.site;
            domainInput.value = info.domain || '';
            toast(info.domain ? `${info.domain} bu siteye bağlandı. DNS kaydınızı PHP sunucusuna yönlendirin.` : 'Özel alan adı kaldırıldı.', 'success');
            paintOverview();
        } catch (error) { toastError(error); }
    }));
    domainInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveDomain.click(); } });

    const overview = h('div');
    function paintOverview() {
        clear(overview, h('div', { class: 'grid grid-2' },
            card({
                title: 'Siteniz yayında', iconName: 'globe',
                actions: [linkBtn('Siteyi aç', info.domainUrl || info.url, { variant: 'primary', iconName: 'external', attrs: { target: '_blank', rel: 'noopener' } })],
                body: h('dl', { class: 'kv' },
                    h('dt', {}, 'Adres'), h('dd', {}, copyable(info.url)),
                    info.domainUrl ? [h('dt', {}, 'Alan adı'), h('dd', {}, copyable(info.domainUrl))] : null,
                    h('dt', {}, 'PHP'), h('dd', {}, `PHP ${info.phpVersion} · mysqli, PDO, GD, zip, intl`),
                    h('dt', {}, 'Kullanım'), h('dd', {}, `${fmtBytes(info.usage.bytes)} · ${info.usage.files} dosya`),
                    h('dt', {}, 'Veritabanı'), h('dd', {}, h('span', { class: 'small text-2' }, 'Kodunuzda'), h('code', {}, 'panel_db()'), h('span', { class: 'small text-2' }, 'ile hazır PDO bağlantısı'))),
                footer: [btn('İzinleri onar', { size: 'sm', variant: 'ghost', iconName: 'refresh', onClick: async e => withBusy(e.currentTarget, async () => {
                    try { const d = await api(`${base}/repair`, { method: 'POST' }); toast(d.message, 'success'); } catch (error) { toastError(error); }
                }) })]
            }),
            card({
                title: 'Özel alan adı', iconName: 'link',
                sub: 'Kendi alan adınızı sitenize bağlayın.',
                body: h('div', { class: 'form-stack' },
                    h('div', { class: 'field' }, h('div', { class: 'input-group' }, domainInput, saveDomain), domainError),
                    h('p', { class: 'small muted' }, 'Alan adınızın A kaydını PHP sunucusunun IP adresine yönlendirin. Boş bırakıp kaydederseniz bağlantı kaldırılır.'))
            })));
    }
    paintOverview();

    async function installTemplate(t, wipe, button) {
        const ok = await confirmDialog(wipe
            ? { title: `${t.name} kurulsun mu?`, message: 'Mevcut site dosyalarınızın TAMAMI silinip şablon temiz olarak kurulacak. Bu işlem geri alınamaz.', confirmText: 'Siteyi değiştir', danger: true }
            : { title: `${t.name} mevcut dosyaların üzerine kurulsun mu?`, message: 'Şablon dosyaları sitenize kopyalanır; aynı adlı dosyaların üzerine yazılır, diğer dosyalarınız korunur.', confirmText: 'Üzerine kur' });
        if (!ok) return;
        await withBusy(button, async () => {
            try {
                await api(`${base}/template`, { method: 'POST', body: { template: t.id, wipe } });
                toast('Şablon kuruldu.', 'success');
                fm.reload();
                info = await api(base).catch(() => info);
                paintOverview();
            } catch (error) { toastError(error); }
        });
    }

    const templates = card({
        title: 'Hazır şablonlar', iconName: 'layers', sub: 'Tek tıkla profesyonel bir sunucu sitesi kurun.',
        body: h('div', { class: 'grid grid-2' }, info.templates.map(t => {
            const installBtn = btn('Temiz kur', { size: 'sm', variant: 'primary', onClick: () => installTemplate(t, true, installBtn) });
            const mergeBtn = btn('Üzerine kur', { size: 'sm', onClick: () => installTemplate(t, false, mergeBtn) });
            return h('div', { class: 'option-card' }, h('h3', {}, t.name), h('p', { class: 'small text-2' }, t.description), h('div', { class: 'foot' }, installBtn, mergeBtn));
        }))
    });

    const fm = createFileManager({
        rootLabel: `site/${info.port}`,
        list: path => api(`${base}/files?path=${enc(path)}`),
        view: file => api(`${base}/files/view?file=${enc(file)}`).then(d => d.content),
        save: (file, content) => api(`${base}/files/edit`, { method: 'POST', body: { file, content } }),
        remove: path => api(`${base}/files?path=${enc(path)}`, { method: 'DELETE' }),
        mkdir: (path, name) => api(`${base}/files/mkdir`, { method: 'POST', body: { path, name } }),
        rename: (from, to) => api(`${base}/files/rename`, { method: 'POST', body: { from, to } }),
        downloadUrl: path => `${base}/files/download?file=${enc(path)}`,
        openUrl: file => (/\.(php|html?|css|js|txt|png|jpe?g|gif|svg|webp)$/i.test(file.name) ? urlFor(file.path) : null),
        uploadUrl: `${base}/files/upload`,
        uploadFolderUrl: `${base}/files/upload-folder`,
        zipUploadUrl: `${base}/zip`,
        zipWipeAllowed: true,
        zipStripRootOption: true,
        newFilePlaceholder: 'sayfa.php',
        newFileTemplate: name => (name.toLowerCase().endsWith('.php') ? '<?php\n\n' : ''),
        batchFiles: 40
    });
    onCleanup(() => fm.abort());

    append(panel, overview, templates,
        card({ title: 'Site dosyaları', iconName: 'folder', sub: 'WordPress gibi hazır yazılımları ZIP olarak yükleyip tek adımda açabilirsiniz.', bodyClass: 'tight', body: fm.el }));
}

// ---------------------------------------------------------------------------
//  Database (MySQL)
// ---------------------------------------------------------------------------

/** True when a statement can change or destroy data/schema. */
function isWriteQuery(sql) {
    const stripped = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*(--|#)[^\n]*/g, '\n').trim();
    const head = (stripped.match(/^[a-z]+/i) || [''])[0].toLowerCase();
    if (['drop', 'truncate', 'delete', 'alter', 'rename', 'update', 'replace', 'create', 'insert', 'grant', 'revoke'].includes(head)) return true;
    return false;
}

function isUnboundedWrite(sql) {
    const s = sql.replace(/\s+/g, ' ').toLowerCase();
    return /^\s*(update|delete)\b/.test(s) && !/\bwhere\b/.test(s);
}

export async function databaseTab({ server, panel }) {
    panel.appendChild(loading());
    let resource;
    try {
        const data = await api('/api/mysql/resources');
        resource = (data.resources || []).find(r => r.serverId === server.id);
    } catch (error) { clear(panel, errorBox(error)); return; }
    clear(panel);
    if (!resource) {
        panel.appendChild(card({ body: emptyState({ iconName: 'database', title: 'Veritabanı atanmamış', text: 'Bu sunucu için MySQL hesabı bulunamadı. Onarım ile yeniden oluşturabilirsiniz.',
            action: btn('Veritabanını oluştur', { variant: 'primary', onClick: async e => withBusy(e.currentTarget, async () => {
                try { await api(`/api/mysql/resources/${server.id}/repair`, { method: 'POST' }); toast('Veritabanı oluşturuldu.', 'success'); clear(panel); databaseTab({ server, panel }); } catch (error) { toastError(error); }
            }) }) }) }));
        return;
    }

    const passwordEl = h('code', {}, '••••••••••••');
    let revealed = false;
    const exportBtn = btn('SQL yedeği indir', { iconName: 'download', onClick: e => withBusy(e.currentTarget, () =>
        downloadFile(`/api/mysql/databases/${enc(resource.database)}/export`, `${resource.database}.sql`).then(() => toast('Yedek indirildi.', 'success', 2000)).catch(toastError)) });
    const credentials = card({
        title: 'Bağlantı bilgileri', iconName: 'key',
        actions: [
            exportBtn,
            moreMenu(close => [
                menuItem('Şifreyi yenile', async () => {
                    close();
                    if (!(await confirmDialog({ title: 'Veritabanı şifresi yenilensin mi?', message: 'Yeni şifre oyun sunucusunun sql.cfg dosyasına ve web sitenizin yapılandırmasına otomatik yazılır. Harici araçlarda kayıtlı eski şifreyi güncellemeniz gerekir.', confirmText: 'Şifreyi yenile' }))) return;
                    try { const d = await api(`/api/mysql/resources/${server.id}/rotate-password`, { method: 'POST' }); resource = { ...resource, ...d.resource }; toast('Şifre yenilendi.', 'success'); if (revealed) passwordEl.textContent = resource.password; } catch (error) { toastError(error); }
                }, { iconName: 'refresh' }),
                menuItem('Hesabı onar', async () => {
                    close();
                    try { const d = await api(`/api/mysql/resources/${server.id}/repair`, { method: 'POST' }); toast(d.message, 'success'); } catch (error) { toastError(error); }
                }, { iconName: 'settings' })
            ], { size: 'sm' })
        ],
        body: h('dl', { class: 'kv' },
            h('dt', {}, 'Sunucu içi host'), h('dd', {}, copyable(`${resource.host}:${resource.mysqlPort}`), h('span', { class: 'small muted' }, 'Oyun sunucusu ve web sitesi için')),
            resource.externalHost ? [h('dt', {}, 'Uzak bağlantı'), h('dd', {}, copyable(`${resource.externalHost}:${resource.externalPort}`))] : null,
            h('dt', {}, 'Veritabanı'), h('dd', {}, copyable(resource.database)),
            h('dt', {}, 'Kullanıcı'), h('dd', {}, copyable(resource.username)),
            h('dt', {}, 'Şifre'), h('dd', {}, h('span', { class: 'copyable' }, passwordEl,
                btn(null, { size: 'xs', variant: 'ghost', iconName: 'eye', title: 'Göster/gizle', onClick: () => { revealed = !revealed; passwordEl.textContent = revealed ? resource.password : '••••••••••••'; } }),
                btn(null, { size: 'xs', variant: 'ghost', iconName: 'copy', title: 'Kopyala', onClick: () => copyText(resource.password) }))))
    });

    const tablesBox = h('div', {}, loading());
    async function loadTables() {
        try {
            const data = await api(`/api/mysql/databases/${enc(resource.database)}/tables`);
            clear(tablesBox, table([
                { label: 'Tablo', render: t => h('button', { class: 'file-name', type: 'button', onClick: () => browseTable(t.name) }, icon('database', 'icon-sm'), h('span', {}, t.name)), sort: t => t.name },
                { label: 'Satır', type: 'num', render: t => String(t.rows ?? 0), sort: t => t.rows || 0 },
                { label: 'Boyut', type: 'num', render: t => fmtBytes(t.size), sort: t => t.size || 0 },
                { label: 'Motor', key: 'engine', hideSm: true }
            ], data.tables, { empty: 'Veritabanında tablo yok.', scrollY: true }));
        } catch (error) { clear(tablesBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    function browseTable(name) {
        let offset = 0;
        const body = h('div', {}, loading());
        const pagerText = h('div', { class: 'left' });
        const prev = btn('Önceki', { size: 'sm', iconName: 'arrowLeft', onClick: () => { offset = Math.max(0, offset - 100); load(); } });
        const next = btn('Sonraki', { size: 'sm', iconName: 'arrowRight', onClick: () => { offset += 100; load(); } });
        async function load() {
            clear(body, loading());
            try {
                const data = await api(`/api/mysql/databases/${enc(resource.database)}/tables/${enc(name)}/data?limit=100&offset=${offset}`);
                clear(body, table(data.columns.map(c => ({ label: c, render: r => (r[c] === null ? h('span', { class: 'muted' }, 'NULL') : String(r[c]).slice(0, 300)) })), data.rows, { empty: 'Tablo boş.' }));
                pagerText.textContent = data.total ? `${offset + 1}–${Math.min(offset + data.rows.length, data.total)} / ${data.total}` : '0 kayıt';
                prev.disabled = offset <= 0;
                next.disabled = offset + data.rows.length >= data.total;
            } catch (error) { clear(body, errorBox(error)); }
        }
        openModal({ title: `${resource.database}.${name}`, size: 'xl', bodyClass: 'flush', body, footer: [pagerText, prev, next] });
        load();
    }

    const sql = h('textarea', { class: 'textarea code', rows: 6, spellcheck: 'false', placeholder: 'SELECT * FROM csstats ORDER BY kills DESC LIMIT 20;', 'aria-label': 'SQL sorgusu' });
    const result = h('div');
    const runBtn = btn('Çalıştır', { variant: 'primary', iconName: 'play' });
    const run = () => withBusy(runBtn, async () => {
        const query = sql.value.trim();
        if (!query) return;
        if (isWriteQuery(query)) {
            const unbounded = isUnboundedWrite(query);
            const ok = await confirmDialog({
                title: unbounded ? 'WHERE koşulu olmayan sorgu' : 'Veri değiştiren sorgu',
                message: unbounded ? 'Bu UPDATE/DELETE sorgusu tablodaki TÜM satırları etkiler. Önce SQL yedeği almanız önerilir.' : 'Bu sorgu veriyi veya tablo yapısını kalıcı olarak değiştirebilir. Devam edilsin mi?',
                confirmText: 'Çalıştır', danger: true, requireText: unbounded ? 'ONAYLA' : null
            });
            if (!ok) return;
        }
        clear(result, loading('Sorgu çalışıyor…'));
        try {
            const data = await api('/api/mysql/query', { method: 'POST', body: { database: resource.database, sql: query } });
            if (!data.columns.length) {
                clear(result, h('div', { class: 'form-success' }, `${data.message || 'Sorgu çalıştı.'} (${data.elapsedMs} ms)`));
                loadTables();
                return;
            }
            clear(result,
                h('div', { class: 'row row-sm' }, h('span', { class: 'small muted' }, `${data.rowCount} satır · ${data.elapsedMs} ms${data.truncated ? ' · ilk 1000 satır gösteriliyor' : ''}`), h('span', { class: 'spacer' }),
                    btn('CSV', { size: 'xs', iconName: 'download', onClick: () => downloadCsv(`${resource.database}-sorgu.csv`, data.columns.map(c => ({ key: c, label: c })), data.rows) })),
                h('div', { class: 'card mt-2' }, table(data.columns.map(c => ({ label: c, render: r => (r[c] === null ? h('span', { class: 'muted' }, 'NULL') : String(r[c]).slice(0, 300)) })), data.rows, { empty: 'Sonuç yok.', scrollY: true })));
        } catch (error) { clear(result, h('div', { class: 'form-error' }, error.message)); }
    });
    runBtn.addEventListener('click', run);
    sql.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

    append(panel,
        h('div', { class: 'grid grid-2' }, credentials,
            card({ title: 'Tablolar', iconName: 'list', actions: [refreshBtn(loadTables)], bodyClass: 'tight', body: tablesBox })),
        card({ title: 'SQL sorgusu', iconName: 'terminal', sub: 'Sorgular yalnızca bu sunucunun veritabanında, kendi kullanıcınızla çalışır. Ctrl+Enter ile çalıştırın.', body: h('div', { class: 'form-stack' }, sql, h('div', { class: 'row' }, runBtn), result) }));
    loadTables();
}

// ---------------------------------------------------------------------------
//  FastDL
// ---------------------------------------------------------------------------

const FASTDL_CATEGORIES = [['maps', 'Haritalar'], ['models', 'Modeller'], ['sound', 'Sesler'], ['sprites', 'Sprite'], ['gfx', 'Gökyüzü (gfx)']];

export function fastdlTab({ server, panel }) {
    const listBox = h('div', {}, loading());
    const log = h('pre', { class: 'log-box short', hidden: true });
    const progress = h('div', { hidden: true });
    const collapsed = new Set();
    let tree = [];

    function flatten(items, depth = 0, out = []) {
        items.forEach(item => {
            out.push({ ...item, depth });
            if (item.children && !collapsed.has(item.path)) flatten(item.children, depth + 1, out);
        });
        return out;
    }

    function paint() {
        const all = [];
        (function walk(items) { items.forEach(i => { all.push(i); if (i.children) walk(i.children); }); })(tree);
        const files = all.filter(r => !r.isDir);
        const total = files.reduce((s, f) => s + f.size, 0);
        const rows = flatten(tree);
        clear(listBox,
            h('div', { class: 'fm-toolbar' }, badge(`${files.length} dosya`, 'accent'), badge(fmtBytes(total)), h('span', { class: 'spacer' }),
                btn('Tümünü daralt', { size: 'xs', variant: 'ghost', onClick: () => { all.filter(r => r.isDir).forEach(r => collapsed.add(r.path)); paint(); } }),
                btn('Tümünü aç', { size: 'xs', variant: 'ghost', onClick: () => { collapsed.clear(); paint(); } })),
            table([
                { label: 'Dosya', render: r => (r.isDir
                    ? h('button', { type: 'button', class: 'file-name is-dir', 'aria-expanded': collapsed.has(r.path) ? 'false' : 'true', style: { paddingLeft: `${r.depth * 18}px` }, onClick: () => { if (collapsed.has(r.path)) collapsed.delete(r.path); else collapsed.add(r.path); paint(); } },
                        icon(collapsed.has(r.path) ? 'arrowRight' : 'arrowDown', 'icon-sm'), icon('folder', 'icon-sm'), h('span', {}, r.name))
                    : h('span', { class: 'file-name', style: { paddingLeft: `${r.depth * 18 + 20}px` } }, icon('file', 'icon-sm'), h('span', {}, r.name))) },
                { label: 'Boyut', type: 'num', render: r => (r.isDir ? null : fmtBytes(r.size)) },
                { label: '', type: 'actions', render: r => (r.isDir ? null : btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'FastDL kopyasını sil', onClick: async () => {
                    if (!(await confirmDialog({ title: 'FastDL kopyası silinsin mi?', message: `${r.path} yalnızca FastDL'den silinir; oyun sunucusundaki dosya kalır. Bir sonraki eşitlemede tekrar kopyalanır.`, confirmText: 'Sil', danger: true }))) return;
                    try { await api(`/api/fastdl/${server.port}/file?path=${enc(r.path)}`, { method: 'DELETE' }); toast('Silindi.', 'success', 1800); load(); } catch (error) { toastError(error); }
                } })) }
            ], rows, { empty: 'FastDL klasörü boş. Eşitleme başlatın.', scrollY: true }));
    }

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/fastdl/${server.port}/files`);
            tree = data.files || [];
            paint();
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const chosen = new Set(FASTDL_CATEGORIES.map(c => c[0]));
    const catChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Eşitlenecek klasörler' }, FASTDL_CATEGORIES.map(([id, label]) => {
        const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onClick: () => {
            if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
            chip.setAttribute('aria-pressed', chosen.has(id) ? 'true' : 'false');
        } }, label);
        return chip;
    }));
    const syncBtn = btn('Şimdi eşitle', { variant: 'primary', iconName: 'refresh' });
    syncBtn.addEventListener('click', () => withBusy(syncBtn, async () => {
        if (!chosen.size) return toast('En az bir klasör seçin.', 'warning');
        if (server.state !== 'running') return toast('Eşitleme için sunucunun çalışıyor olması gerekir.', 'warning');
        log.hidden = false;
        log.textContent = `${[...chosen].join(', ')} eşitleniyor…`;
        try {
            const data = await api(`/api/fastdl/${server.port}/sync`, { method: 'POST', body: { categories: [...chosen] }, timeoutMs: 600000 });
            log.textContent = (data.log || []).filter(l => !l.startsWith('SKIP')).join('\n') || data.message;
            toast(data.message, data.success ? 'success' : 'warning');
            load();
        } catch (error) { log.textContent = error.message; toastError(error); }
    }));

    const upInput = h('input', { type: 'file', class: 'input', accept: '.bsp,.wad,.mdl,.spr,.wav,.mp3,.tga,.res,.txt,.bmp' });
    const subdir = select([{ value: 'maps', label: 'maps/' }, { value: 'models', label: 'models/' }, { value: 'sound', label: 'sound/' }, { value: 'sprites', label: 'sprites/' }, { value: 'gfx/env', label: 'gfx/env/' }, { value: '', label: '(kök klasör)' }], { value: 'maps' });
    const upBtn = btn('FastDL\'e yükle', { variant: 'primary', iconName: 'upload' });
    upBtn.addEventListener('click', () => withBusy(upBtn, async () => {
        if (!upInput.files.length) return toast('Bir dosya seçin.', 'warning');
        const form = new FormData();
        form.append('subdir', subdir.value);
        form.append('file', upInput.files[0]);
        try {
            const data = await uploadWithBar(progress, `/api/fastdl/${server.port}/upload`, form, upInput.files[0].name);
            toast(data.message || 'Yüklendi.', 'success');
            upInput.value = '';
            load();
        } catch (error) { toastError(error); }
    }));

    append(panel,
        h('div', { class: 'grid grid-2' },
            card({
                title: 'Hızlı indirme (FastDL)', iconName: 'download',
                sub: 'Oyuncular özel haritaları, modelleri ve sesleri bu adresten hızlıca indirir.',
                body: h('div', { class: 'form-stack' },
                    h('dl', { class: 'kv' }, h('dt', {}, 'sv_downloadurl'), h('dd', {}, copyable(server.fastdl.url))),
                    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Eşitlenecek klasörler'), catChips),
                    h('p', { class: 'small muted' }, 'Yüklediğiniz harita ve dosyalar otomatik eşitlenir. Güvenlik gereği .cfg/.ini gibi yapılandırma dosyaları asla FastDL\'e kopyalanmaz.'),
                    log),
                footer: [syncBtn]
            }),
            card({
                title: 'Doğrudan yükle', iconName: 'upload', sub: 'Yalnızca istemcinin indireceği dosyalar (sunucuya kopyalanmaz).',
                body: h('div', { class: 'form-stack' }, field('Dosya', upInput), field('Hedef klasör', subdir), progress),
                footer: [upBtn]
            })),
        card({ title: 'FastDL içeriği', iconName: 'folder', actions: [refreshBtn(load)], bodyClass: 'tight', body: listBox }));
    load();
}

// ---------------------------------------------------------------------------
//  Scheduled tasks
// ---------------------------------------------------------------------------

const TASK_ACTIONS = [
    { value: 'restart', label: 'Sunucuyu yeniden başlat', icon: 'refresh' },
    { value: 'say', label: 'Oyun içi duyuru (say)', icon: 'megaphone' },
    { value: 'map', label: 'Harita değiştir', icon: 'map' },
    { value: 'rcon', label: 'RCON komutu', icon: 'terminal' }
];
const WEEKDAYS = [[1, 'Pzt'], [2, 'Sal'], [3, 'Çar'], [4, 'Per'], [5, 'Cum'], [6, 'Cmt'], [0, 'Paz']];

function describeSchedule(t) {
    if (t.schedule_type === 'interval') {
        const m = t.interval_minutes;
        return m % 1440 === 0 ? `Her ${m / 1440} günde bir` : m % 60 === 0 ? `Her ${m / 60} saatte bir` : `Her ${m} dakikada bir`;
    }
    if (t.schedule_type === 'daily') return `Her gün ${t.time_of_day}`;
    const days = WEEKDAYS.filter(([d]) => t.weekdays.includes(d)).map(([, l]) => l);
    return `${days.join(', ')} · ${t.time_of_day}`;
}

function describeAction(t) {
    const a = TASK_ACTIONS.find(x => x.value === t.action);
    if (t.action === 'restart') return a.label;
    return h('span', { class: 'cell-title' }, h('strong', {}, a ? a.label : t.action), h('span', { class: 'mono' }, t.payload));
}

const TASK_STATUS = { ok: ['Başarılı', 'success'], error: ['Hata', 'danger'], skipped: ['Atlandı', 'warning'] };

export function tasksTab({ server, panel }) {
    const listBox = h('div', {}, loading());
    let timeZone = 'Europe/Istanbul';
    // Schedules are defined in the panel's zone, so show run times in it too.
    const fmtInZone = value => {
        try { return new Date(value).toLocaleString('tr-TR', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return fmtDateTime(value); }
    };

    function taskForm(existing = null) {
        return formDialog({
            title: existing ? 'Görevi düzenle' : 'Yeni zamanlanmış görev',
            intro: `Saatler ${timeZone} saat dilimine göredir. Görevler sunucu çalışıyorsa uygulanır; restart görevi kapalı sunucuyu da başlatır.`,
            fields: [
                { name: 'name', label: 'Görev adı', value: existing ? existing.name : '', placeholder: 'Gece yeniden başlatma', required: true, maxlength: 80, full: true },
                { name: 'action', label: 'Eylem', type: 'select', value: existing ? existing.action : 'restart', options: TASK_ACTIONS.map(a => ({ value: a.value, label: a.label })) },
                { name: 'payload', label: 'Komut / mesaj / harita', value: existing ? existing.payload || '' : '', placeholder: 'Örn. de_dust2 veya Discord: discord.gg/...', showIf: v => v.action !== 'restart', required: true, maxlength: 200,
                    help: 'RCON görevlerinde tek komut yazın (; kullanılamaz).',
                    validate: (v, values) => (values.action === 'map' && !/^[A-Za-z0-9_.-]{1,64}$/.test(v.trim()) ? 'Geçerli bir harita adı girin.' : values.action === 'rcon' && /[;"\n]/.test(v) ? 'Tek komut girin; ; ve " kullanılamaz.' : null) },
                { name: 'schedule_type', label: 'Tekrar', type: 'select', value: existing ? existing.schedule_type : 'daily', options: [{ value: 'daily', label: 'Her gün' }, { value: 'weekly', label: 'Haftanın belirli günleri' }, { value: 'interval', label: 'Belirli aralıklarla' }] },
                { name: 'time_of_day', label: 'Saat', type: 'time', value: existing && existing.time_of_day ? existing.time_of_day : '05:00', showIf: v => v.schedule_type !== 'interval', required: true },
                { name: 'interval_minutes', label: 'Aralık (dakika)', type: 'number', value: existing && existing.interval_minutes ? String(existing.interval_minutes) : '30', min: 5, max: 10080, showIf: v => v.schedule_type === 'interval', required: true },
                { name: 'weekdays', label: 'Günler', type: 'chips', value: existing ? existing.weekdays : [1, 2, 3, 4, 5], options: WEEKDAYS.map(([value, label]) => ({ value, label })), showIf: v => v.schedule_type === 'weekly', required: true },
                { name: 'enabled', type: 'checkbox', checkLabel: 'Görev etkin', value: existing ? existing.enabled : true, full: true }
            ],
            submitText: existing ? 'Kaydet' : 'Görevi oluştur',
            onSubmit: values => {
                const body = { ...values, weekdays: (values.weekdays || []).map(Number) };
                return existing
                    ? api(`/api/servers/${server.id}/tasks/${existing.id}`, { method: 'PUT', body })
                    : api(`/api/servers/${server.id}/tasks`, { method: 'POST', body });
            }
        }).then(result => { if (result) { toast(existing ? 'Görev güncellendi.' : 'Görev oluşturuldu.', 'success'); load(); } });
    }

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/servers/${server.id}/tasks`);
            timeZone = data.timeZone || timeZone;
            if (!data.tasks.length) {
                clear(listBox, emptyState({ iconName: 'calendar', title: 'Henüz görev yok', text: 'Gece otomatik yeniden başlatma, belirli aralıklarla oyun içi duyuru veya saatli harita değişimi gibi işleri zamanlayın.',
                    action: btn('İlk görevi oluştur', { variant: 'primary', iconName: 'plus', onClick: () => taskForm() }) }));
                return;
            }
            clear(listBox, table([
                { label: 'Görev', render: t => h('div', { class: 'cell-title' }, h('strong', {}, t.name), h('span', {}, describeSchedule(t))), sort: t => t.name },
                { label: 'Eylem', render: describeAction, hideSm: true },
                { label: 'Sonraki çalışma', type: 'date', render: t => (t.enabled && t.next_run_at ? fmtInZone(t.next_run_at) : h('span', { class: 'muted' }, 'Pasif')), sort: t => (t.next_run_at ? new Date(t.next_run_at).getTime() : Infinity) },
                { label: 'Son sonuç', render: t => (t.last_status ? h('span', { class: 'row row-sm', title: t.last_message || '' }, badge(...(TASK_STATUS[t.last_status] || [t.last_status])), h('span', { class: 'small muted' }, fmtRelative(t.last_run_at))) : h('span', { class: 'muted small' }, 'Henüz çalışmadı')) },
                { label: 'Etkin', render: t => switchControl(h('span', { class: 'sr-only' }, `${t.name} etkin`), t.enabled, async (checked, el) => {
                    try { await api(`/api/servers/${server.id}/tasks/${t.id}`, { method: 'PUT', body: { enabled: checked } }); toast(checked ? 'Görev etkinleştirildi.' : 'Görev durduruldu.', 'success', 2000); load(); } catch (error) { el.checked = !checked; toastError(error); }
                }) },
                { label: '', type: 'actions', render: t => tableActions(
                    btn('Şimdi çalıştır', { size: 'xs', iconName: 'play', onClick: async e => {
                        if (t.action === 'restart' && !(await confirmDialog({ title: 'Şimdi yeniden başlatılsın mı?', message: 'Sunucu hemen yeniden başlatılacak; oyuncuların bağlantısı kopar.', confirmText: 'Yeniden başlat' }))) return;
                        await withBusy(e.currentTarget, async () => {
                            try {
                                const r = await api(`/api/servers/${server.id}/tasks/${t.id}/run`, { method: 'POST', timeoutMs: 180000 });
                                toast(r.message || 'Görev çalıştırıldı.', r.status === 'ok' ? 'success' : 'warning');
                                load();
                            } catch (error) { toastError(error); }
                        });
                    } }),
                    moreMenu(close => [
                        menuItem('Düzenle', () => { close(); taskForm(t); }, { iconName: 'edit' }),
                        menuSep(),
                        menuItem('Sil', async () => {
                            close();
                            if (!(await confirmDialog({ title: 'Görev silinsin mi?', message: `"${t.name}" görevi kalıcı olarak silinecek.`, confirmText: 'Sil', danger: true }))) return;
                            try { await api(`/api/servers/${server.id}/tasks/${t.id}`, { method: 'DELETE' }); toast('Görev silindi.', 'success'); load(); } catch (error) { toastError(error); }
                        }, { iconName: 'trash', danger: true })
                    ])) }
            ], data.tasks));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    panel.appendChild(card({
        title: 'Zamanlanmış görevler', iconName: 'calendar', sub: 'Otomatik restart, duyuru, harita değişimi ve RCON komutları. Sunucu başına en fazla 20 görev.',
        actions: [refreshBtn(load), btn('Yeni görev', { variant: 'primary', iconName: 'plus', onClick: () => taskForm() })],
        bodyClass: 'tight', body: listBox
    }));
    load();
}

// ---------------------------------------------------------------------------
//  Settings (server.cfg + launch parameters + quick editor)
// ---------------------------------------------------------------------------

const CVAR_GROUPS = [
    { title: 'Genel', fields: [
        { key: 'name', label: 'Sunucu adı (hostname)', type: 'text', full: true },
        { key: 'rconPassword', label: 'RCON şifresi', type: 'secret' },
        { key: 'sv_password', label: 'Sunucu şifresi (sv_password)', type: 'text', placeholder: 'Boş = herkese açık' },
        { key: 'startupMap', label: 'Başlangıç haritası', type: 'text' },
        { key: 'fpsLimit', label: 'Tick hızı (sys_ticrate)', type: 'select', options: ['1000', '500', '300', '100'] }
    ] },
    { title: 'Oyun kuralları', fields: [
        { key: 'mp_timelimit', label: 'Harita süresi (dk)', type: 'number' },
        { key: 'mp_roundtime', label: 'Raunt süresi (dk)', type: 'number', step: '0.1' },
        { key: 'mp_freezetime', label: 'Donma süresi (sn)', type: 'number' },
        { key: 'mp_c4timer', label: 'C4 süresi (sn)', type: 'number' },
        { key: 'mp_startmoney', label: 'Başlangıç parası', type: 'number' },
        { key: 'mp_buytime', label: 'Satın alma süresi (dk)', type: 'number', step: '0.1' },
        { key: 'mp_limitteams', label: 'Takım farkı limiti', type: 'number' },
        { key: 'mp_forcechasecam', label: 'İzleyici kamerası', type: 'select', options: [{ value: '0', label: 'Herkesi izle' }, { value: '1', label: 'Sadece takım' }, { value: '2', label: 'Sabit kamera' }] },
        { key: 'sv_gravity', label: 'Yer çekimi', type: 'number' },
        { key: 'sv_maxspeed', label: 'Maksimum hız', type: 'number' },
        { key: 'decalfrequency', label: 'Sprey sıklığı (sn)', type: 'number' }
    ] },
    { title: 'Seçenekler', fields: [
        { key: 'mp_friendlyfire', label: 'Takım ateşi', type: 'bool' },
        { key: 'mp_autoteambalance', label: 'Otomatik takım dengesi', type: 'bool' },
        { key: 'mp_footsteps', label: 'Ayak sesleri', type: 'bool' },
        { key: 'mp_flashlight', label: 'El feneri', type: 'bool' },
        { key: 'sv_voiceenable', label: 'Sesli sohbet', type: 'bool' },
        { key: 'sv_alltalk', label: 'Herkes konuşabilir (alltalk)', type: 'bool' },
        { key: 'pausable', label: 'Oyun duraklatılabilir', type: 'bool' },
        { key: 'sv_cheats', label: 'Hile komutları (sv_cheats)', type: 'bool' }
    ] }
];

function startupCard(server) {
    const body = h('div', {}, loading());
    const controls = {};
    const saveBtn = btn('Kaydet', { variant: 'ghost' });
    const saveRestartBtn = btn('Kaydet ve yeniden başlat', { variant: 'primary', iconName: 'refresh' });
    async function save(restart, button) {
        const values = Object.fromEntries(Object.entries(controls).map(([k, c]) => [k, c.get()]));
        if (restart && !(await confirmDialog({ title: 'Sunucu yeniden başlatılsın mı?', message: 'Başlatma parametreleri yalnızca sunucu yeniden başladığında uygulanır. Oyuncuların bağlantısı kopar.', confirmText: 'Kaydet ve yeniden başlat' }))) return;
        await withBusy(button, async () => {
            try {
                const data = await api(`/api/servers/${server.id}/startup`, { method: 'PUT', body: { ...values, restart }, timeoutMs: 180000 });
                toast(data.message, 'success');
            } catch (error) { toastError(error); }
        });
    }
    saveBtn.addEventListener('click', () => save(false, saveBtn));
    saveRestartBtn.addEventListener('click', () => save(true, saveRestartBtn));
    api(`/api/servers/${server.id}/startup`).then(data => {
        const v = data.startup;
        const pingboost = select([{ value: '0', label: 'Kapalı' }, { value: '1', label: '1 · select()' }, { value: '2', label: '2 · usleep (önerilen)' }, { value: '3', label: '3 · yoğun döngü' }], { value: String(v.pingboost) });
        const ticrate = select(['1000', '500', '300', '100'], { value: String(v.sysTicrate) });
        const fpsMax = select(['1000', '500', '300', '100'], { value: String(v.fpsMax) });
        const insecure = h('input', { type: 'checkbox', checked: v.insecure === 1 });
        const nomaster = h('input', { type: 'checkbox', checked: v.nomaster === 1 });
        controls.pingboost = { get: () => Number(pingboost.value) };
        controls.sysTicrate = { get: () => Number(ticrate.value) };
        controls.fpsMax = { get: () => Number(fpsMax.value) };
        controls.insecure = { get: () => (insecure.checked ? 1 : 0) };
        controls.nomaster = { get: () => (nomaster.checked ? 1 : 0) };
        clear(body, h('div', { class: 'form-stack' },
            h('div', { class: 'form-grid form-grid-3' },
                field('-pingboost', pingboost, { help: 'Sunucu döngü zamanlayıcısı' }),
                field('+sys_ticrate', ticrate, { help: 'Saniyedeki işlem sayısı' }),
                field('+fps_max', fpsMax, { help: 'Sunucu FPS üst sınırı' })),
            h('label', { class: 'check' }, insecure, 'VAC korumasını kapat (-insecure) — yalnızca test sunucuları için'),
            h('label', { class: 'check' }, nomaster, 'Ana sunucu listesine bildirme (-nomaster) — sunucu internet listesinde görünmez')));
    }).catch(error => clear(body, errorBox(error)));
    return card({ title: 'Başlatma parametreleri', iconName: 'rocket', sub: 'hlds_run komut satırı seçenekleri; sunucu yeniden başladığında uygulanır.', body, footer: [saveBtn, saveRestartBtn] });
}

export async function settingsTab({ server, panel }) {
    panel.appendChild(loading());
    let settings;
    try {
        settings = (await api(`/api/servers/${server.id}/settings`)).settings;
    } catch (error) {
        clear(panel, error.status === 409 || /running|çalış/i.test(error.message) ? card({ body: offlineNotice(server, 'Ayarları okumak için sunucunun çalışıyor olması gerekir.') }) : errorBox(error));
        return;
    }
    clear(panel);
    const controls = {};
    const sections = CVAR_GROUPS.map(group => {
        const grid = h('div', { class: 'form-grid' });
        group.fields.forEach(f => {
            let control;
            const value = settings[f.key] ?? '';
            if (f.type === 'bool') {
                const box = h('input', { type: 'checkbox', checked: String(value) === '1' });
                controls[f.key] = { get: () => (box.checked ? '1' : '0') };
                grid.appendChild(h('label', { class: 'check' }, box, f.label));
                return;
            }
            if (f.type === 'select') control = select(f.options, { value: String(value) });
            else if (f.type === 'secret') {
                const field0 = input({ value, class: 'code', autocomplete: 'off', minlength: 8, maxlength: 64 });
                control = h('div', { class: 'input-group' }, field0, btn(null, { iconName: 'refresh', title: 'Yeni şifre üret', onClick: () => { field0.value = generatePassword(14); } }));
                controls[f.key] = { get: () => field0.value.trim() };
            } else control = input({ type: f.type === 'number' ? 'number' : 'text', value, step: f.step, placeholder: f.placeholder || '', maxlength: 64 });
            if (!controls[f.key]) controls[f.key] = { get: () => control.value.trim() };
            const wrapper = field(f.label, control);
            if (f.full) wrapper.classList.add('full');
            grid.appendChild(wrapper);
        });
        return h('div', { class: 'stack stack-sm' }, h('h3', { class: 'eyebrow' }, group.title), grid);
    });
    const saveBtn = btn('Kaydet ve uygula', { variant: 'primary', iconName: 'check' });
    saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
        const body = {};
        for (const [key, c] of Object.entries(controls)) body[key] = c.get();
        if (body.rconPassword && body.rconPassword.length < 8) return toast('RCON şifresi en az 8 karakter olmalı.', 'error');
        try {
            const data = await api(`/api/servers/${server.id}/settings`, { method: 'POST', body });
            toast(data.message, 'success');
        } catch (error) { toastError(error); }
    }));

    // Quick config editor
    const list = h('div', { class: 'list' }, loading());
    const editorPath = h('span', { class: 'truncate' }, 'Soldan bir dosya seçin');
    const editor = h('textarea', { class: 'editor', spellcheck: 'false', disabled: true, 'aria-label': 'Yapılandırma dosyası' });
    const saveCfg = btn('Kaydet', { size: 'sm', variant: 'primary', iconName: 'check', disabled: true });
    let currentFile = null;
    let dirty = false;
    editor.addEventListener('input', () => { dirty = true; });
    saveCfg.addEventListener('click', () => withBusy(saveCfg, async () => {
        try {
            await api(`/api/files/${server.id}/edit`, { method: 'POST', body: { file: currentFile, content: editor.value } });
            dirty = false;
            toast(`${currentFile} kaydedildi.`, 'success', 2000);
        } catch (error) { toastError(error); }
    }));
    editor.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (currentFile) saveCfg.click(); } });
    api(`/api/servers/${server.id}/configs`).then(data => {
        clear(list, (data.configs || []).map(path => {
            const b = h('button', { type: 'button', title: path, onClick: async () => {
                if (dirty && !(await confirmDialog({ title: 'Kaydedilmemiş değişiklikler', message: `${currentFile} dosyasındaki değişiklikler kaybolacak.`, confirmText: 'Yine de aç' }))) return;
                list.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
                editorPath.textContent = path;
                editor.disabled = true;
                editor.value = 'Yükleniyor…';
                try {
                    const d = await api(`/api/files/${server.id}/view?file=${enc(path)}`);
                    currentFile = path;
                    dirty = false;
                    editor.value = d.content;
                    editor.disabled = false;
                    saveCfg.disabled = false;
                    editor.focus();
                } catch (error) { editor.value = error.message; }
            } }, h('span', {}, path.split('/').pop()), path.includes('/') ? h('small', {}, path.split('/').slice(0, -1).join('/')) : null);
            return b;
        }));
        if (!data.configs.length) clear(list, h('div', { class: 'nav-empty' }, 'Yapılandırma dosyası bulunamadı.'));
    }).catch(error => clear(list, h('div', { class: 'nav-empty text-danger' }, error.message)));

    append(panel,
        card({ title: 'Sunucu ayarları (server.cfg)', iconName: 'sliders', sub: 'Değişiklikler dosyaya yazılır ve sunucu çalışıyorsa anında uygulanır.', body: h('div', { class: 'stack' }, sections), footer: [saveBtn] }),
        startupCard(server),
        card({ title: 'Hızlı yapılandırma düzenleyici', iconName: 'edit', sub: 'Ctrl+S ile kaydedin.', bodyClass: 'tight',
            body: h('div', { class: 'split' }, list, h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, editorPath, saveCfg), editor)) }));
}
