// Tab bodies of the server detail page.
import { append,
    api, h, clear, icon, btn, card, badge, table, field, input, select, switchControl, toast, toastError,
    confirmDialog, formDialog, openModal, withBusy, loading, errorBox, emptyState, copyable, copyText,
    fmtBytes, generatePassword, dropdown, menuItem
} from '../core.js';
import { createFileManager } from '../components/fileManager.js';

const enc = encodeURIComponent;

function offlineNotice(message = 'Sunucu kapalı. Bu bölümü kullanmak için sunucuyu başlatın.') {
    return emptyState({ iconName: 'stop', title: 'Sunucu çalışmıyor', text: message });
}

// ---------------------------------------------------------------------------
//  Console
// ---------------------------------------------------------------------------

export function consoleTab({ server, panel, onCleanup }) {
    const output = h('div', { class: 'console', role: 'log', 'aria-live': 'polite', tabindex: '0' });
    const cmd = input({ placeholder: 'Komut yazın (örn. changelevel de_inferno, sv_restart 1)…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Konsol komutu' });
    const history = [];
    let historyIndex = -1;
    let socket = null;
    let closedByUs = false;
    let reconnectTimer = null;
    const MAX_LINES = 2000;

    function line(text, type = '') {
        const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
        output.appendChild(h('div', { class: type ? `line-${type}` : '' }, text));
        while (output.childElementCount > MAX_LINES) output.firstElementChild.remove();
        if (atBottom) output.scrollTop = output.scrollHeight;
    }

    function connect() {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${proto}//${window.location.host}/?containerId=${enc(server.id)}`);
        socket.onopen = () => line('— Konsola bağlanıldı —', 'system');
        socket.onmessage = event => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            if (msg.type === 'log') line(msg.data);
            else if (msg.type === 'rcon_response') line(msg.data || '(yanıt yok)', 'system');
            else if (msg.type === 'error') line(msg.data, 'error');
        };
        socket.onclose = () => {
            if (closedByUs) return;
            line('— Bağlantı kesildi, 5 sn içinde yeniden bağlanılacak —', 'error');
            reconnectTimer = setTimeout(connect, 5000);
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
        title: 'Canlı konsol', iconName: 'terminal', sub: 'Sunucu çıktısı canlı akar; komutlar RCON ile gönderilir.',
        actions: [btn('Temizle', { size: 'sm', variant: 'ghost', onClick: () => clear(output) })],
        bodyClass: 'tight',
        body: [output, form, h('div', { class: 'chips', style: { padding: '0 12px 12px' } }, quick.map(q => h('button', { class: 'chip', type: 'button', onClick: () => send(q) }, q)))]
    }));
    if (server.state !== 'running') line('Sunucu kapalı. Başlattığınızda çıktı burada görünecek.', 'system');
    connect();
    onCleanup(() => { closedByUs = true; clearTimeout(reconnectTimer); if (socket) socket.close(); });
    setTimeout(() => cmd.focus(), 50);
}

// ---------------------------------------------------------------------------
//  Logs
// ---------------------------------------------------------------------------

export function logsTab({ server, panel }) {
    const body = h('div');
    let mode = 'console';
    const seg = h('div', { class: 'segmented' });
    function paintSeg() {
        clear(seg, [['console', 'Konsol çıktısı'], ['crash', 'Çökme raporları']].map(([id, label]) =>
            h('button', { type: 'button', class: mode === id ? 'active' : '', onClick: () => { mode = id; paintSeg(); load(); } }, label)));
    }
    async function load() {
        clear(body, loading());
        try {
            if (mode === 'console') {
                const data = await api(`/api/servers/${server.id}/logs?tail=1000`);
                const pre = h('pre', { class: 'log-box' }, data.logs || 'Kayıt yok.');
                clear(body, pre);
                pre.scrollTop = pre.scrollHeight;
            } else {
                const data = await api(`/api/servers/${server.id}/crash-logs`);
                const block = (title, text, okText) => h('div', { class: 'stack', style: { gap: '8px' } },
                    h('div', { class: 'row' }, h('h3', {}, title), text ? badge('Kayıt var', 'danger') : badge('Temiz', 'success')),
                    h('pre', { class: 'log-box short' }, text || okText));
                clear(body, h('div', { class: 'card-body stack' },
                    block('Motor hataları (sys_error.log)', data.sys_error, 'Motor hatası kaydı yok.'),
                    block('Çökme dökümü (debug.log)', data.debug_log, 'Çökme dökümü yok.'),
                    block(`AMX Mod X hataları${data.amxx_file ? ` (${data.amxx_file})` : ''}`, data.amxx_errors, 'Eklenti hatası yok.')));
            }
        } catch (error) {
            clear(body, h('div', { class: 'card-body' }, errorBox(error)));
        }
    }
    paintSeg();
    panel.appendChild(card({ title: 'Loglar ve tanılama', iconName: 'list', actions: [seg, btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: load })], bodyClass: 'tight', body }));
    load();
}

// ---------------------------------------------------------------------------
//  Files
// ---------------------------------------------------------------------------

export function filesTab({ server, panel, onCleanup }) {
    const base = `/api/files/${server.id}`;
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
        sub: server.state === 'running' ? 'Dosyaları sürükleyip bırakarak yükleyebilir, .zip arşivlerini sunucuda açabilirsiniz.' : 'Dosya işlemleri için sunucunun çalışıyor olması gerekir.',
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
    let plugins = [];

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/plugins/${server.id}`);
            if (data.offline) { clear(listBox, offlineNotice()); return; }
            plugins = data.plugins;
            clear(smaSelect, h('option', { value: '' }, data.sourceFiles.length ? 'Kaynak dosya seçin…' : 'scripting klasöründe .sma yok'), data.sourceFiles.map(f => h('option', { value: f }, f)));
            paint();
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function saveOrder(order) {
        try {
            await api(`/api/plugins/${server.id}/order`, { method: 'POST', body: { orderedFilenames: order } });
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
        clear(listBox, plugins.map((p, i) => h('div', { class: 'plugin-row' },
            h('span', { class: 'order' }, String(i + 1)),
            h('div', { class: 'name' }, h('code', {}, p.filename), h('small', {}, p.inIni ? (p.description || 'plugins.ini') : 'plugins.ini dosyasında yok')),
            switchControl('', p.enabled, async (checked, el) => {
                try {
                    await api(`/api/plugins/${server.id}/toggle`, { method: 'POST', body: { filename: p.filename, enable: checked } });
                    toast(`${p.filename} ${checked ? 'etkinleştirildi' : 'devre dışı bırakıldı'}. Değişiklik harita değişiminde geçerli olur.`, 'success', 2500);
                    load();
                } catch (error) { el.checked = !checked; toastError(error); }
            }),
            btn(null, { size: 'xs', iconName: 'arrowUp', title: 'Yukarı taşı', disabled: i === 0, onClick: () => move(i, -1) }),
            btn(null, { size: 'xs', iconName: 'arrowDown', title: 'Aşağı taşı', disabled: i === plugins.length - 1, onClick: () => move(i, 1) }))));
    }

    const fileInput = h('input', { type: 'file', accept: '.sma,.amxx', class: 'input' });
    const addIni = h('input', { type: 'checkbox', checked: true });
    const uploadBtn = btn('Yükle', { variant: 'primary', iconName: 'upload' });
    uploadBtn.addEventListener('click', () => withBusy(uploadBtn, async () => {
        if (!fileInput.files.length) return toast('Bir .sma veya .amxx dosyası seçin.', 'warning');
        const form = new FormData();
        form.append('file', fileInput.files[0]);
        form.append('addToIni', addIni.checked ? 'true' : 'false');
        try {
            const data = await api(`/api/plugins/${server.id}/upload`, { method: 'POST', form });
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
        output.textContent = 'Derleniyor…';
        try {
            const data = await api(`/api/plugins/${server.id}/compile`, { method: 'POST', body: { filename: smaSelect.value, addToIni: compileIni.checked }, timeoutMs: 90000 });
            output.textContent = data.output || data.message;
            output.style.color = data.success ? 'var(--success)' : 'var(--danger)';
            toast(data.message, data.success ? 'success' : 'error');
            if (data.success) load();
        } catch (error) { output.textContent = error.message; output.style.color = 'var(--danger)'; }
    }));

    panel.appendChild(h('div', { class: 'grid grid-aside' },
        card({ title: 'Eklenti sırası (plugins.ini)', iconName: 'puzzle', sub: 'Sıra, eklentilerin yüklenme önceliğidir.', actions: [btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: load })], bodyClass: 'tight', body: listBox }),
        h('div', { class: 'stack' },
            card({ title: 'Eklenti yükle', iconName: 'upload', body: h('div', { class: 'form-stack' }, field('.sma veya .amxx dosyası', fileInput), h('label', { class: 'check' }, addIni, '.amxx dosyasını plugins.ini dosyasına ekle'), uploadBtn) }),
            card({ title: 'Kaynak derle (.sma → .amxx)', iconName: 'zap', body: h('div', { class: 'form-stack' }, field('Kaynak dosya', smaSelect), h('label', { class: 'check' }, compileIni, 'Derlenen eklentiyi plugins.ini dosyasına ekle'), compileBtn, output) }))));
    load();
}

// ---------------------------------------------------------------------------
//  Maps
// ---------------------------------------------------------------------------

export function mapsTab({ server, panel }) {
    const listBox = h('div', {}, loading());
    const cycle = h('textarea', { class: 'textarea code', rows: 16, spellcheck: 'false', 'aria-label': 'mapcycle.txt' });

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/maps/${server.id}`);
            if (data.offline) { clear(listBox, offlineNotice()); return; }
            cycle.value = data.mapcycle.join('\n');
            clear(listBox, table([
                { label: 'Harita', render: m => h('span', { class: 'mono' }, m.name) },
                { label: 'Boyut', class: 'num', render: m => fmtBytes(m.size) },
                { label: 'Döngüde', render: m => (data.mapcycle.includes(m.name) ? badge('Evet', 'success') : badge('Hayır')) },
                { label: '', class: 'actions', render: m => h('div', { class: 'btn-group', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
                    btn('Geç', { size: 'xs', iconName: 'play', title: 'Bu haritaya geç', disabled: server.state !== 'running', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Harita değiştir', message: `Sunucu "${m.name}" haritasına geçecek. Oyuncular yeniden bağlanır.`, confirmText: 'Haritayı değiştir' }))) return;
                        try { await api(`/api/servers/${server.id}/settings`, { method: 'POST', body: { map: m.name } }); toast('Harita değiştiriliyor.', 'success'); } catch (error) { toastError(error); }
                    } }),
                    btn(null, { size: 'xs', iconName: 'trash', variant: 'danger', title: 'Sil', onClick: async () => {
                        if (!(await confirmDialog({ title: 'Harita silinsin mi?', message: `${m.filename} sunucudan ve FastDL'den silinecek.`, confirmText: 'Sil', danger: true }))) return;
                        try { await api(`/api/maps/${server.id}?filename=${enc(m.filename)}`, { method: 'DELETE' }); toast('Harita silindi.', 'success'); load(); } catch (error) { toastError(error); }
                    } })) }
            ], data.maps, { empty: 'maps klasöründe .bsp dosyası yok.' }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const fileInput = h('input', { type: 'file', accept: '.bsp', class: 'input' });
    const addCycle = h('input', { type: 'checkbox', checked: true });
    const uploadBtn = btn('Haritayı yükle', { variant: 'primary', iconName: 'upload' });
    uploadBtn.addEventListener('click', () => withBusy(uploadBtn, async () => {
        if (!fileInput.files.length) return toast('Bir .bsp dosyası seçin.', 'warning');
        const form = new FormData();
        form.append('file', fileInput.files[0]);
        form.append('addToCycle', addCycle.checked ? 'true' : 'false');
        try {
            const data = await api(`/api/maps/${server.id}/upload`, { method: 'POST', form, timeoutMs: 300000 });
            toast(data.warning ? `Yüklendi; FastDL uyarısı: ${data.warning}` : data.message, data.warning ? 'warning' : 'success');
            fileInput.value = '';
            load();
        } catch (error) { toastError(error); }
    }));
    const saveCycle = btn('Döngüyü kaydet', { variant: 'primary', size: 'sm', iconName: 'check' });
    saveCycle.addEventListener('click', () => withBusy(saveCycle, async () => {
        try {
            await api(`/api/maps/${server.id}/mapcycle`, { method: 'POST', body: { mapcycle: cycle.value.split('\n').map(s => s.trim()).filter(Boolean) } });
            toast('mapcycle.txt kaydedildi.', 'success');
            load();
        } catch (error) { toastError(error); }
    }));

    panel.appendChild(h('div', { class: 'grid grid-aside' },
        card({ title: 'Yüklü haritalar', iconName: 'map', actions: [btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: load })], bodyClass: 'tight', body: listBox }),
        h('div', { class: 'stack' },
            card({ title: 'Harita yükle', iconName: 'upload', sub: 'Yüklenen harita otomatik olarak FastDL ile eşitlenir.', body: h('div', { class: 'form-stack' }, field('.bsp dosyası', fileInput), h('label', { class: 'check' }, addCycle, 'Harita döngüsüne ekle'), uploadBtn) }),
            card({ title: 'Harita döngüsü', iconName: 'refresh', sub: 'Her satıra bir harita (mapcycle.txt).', actions: [saveCycle], body: cycle }))));
    load();
}

// ---------------------------------------------------------------------------
//  Players
// ---------------------------------------------------------------------------

export function playersTab({ server, panel }) {
    const live = h('div', {}, loading());
    const board = h('div', {}, loading());
    const historyBox = h('div', {}, loading());

    async function action(name, kind) {
        let reason = '';
        let duration = 0;
        if (kind === 'kick' || kind === 'ban') {
            const values = await formDialog({
                title: kind === 'kick' ? `${name} — at` : `${name} — yasakla`,
                fields: [
                    kind === 'ban' ? { name: 'duration', label: 'Süre (dakika, 0 = kalıcı)', type: 'number', value: '60', min: 0 } : null,
                    { name: 'reason', label: 'Sebep', value: kind === 'kick' ? 'Kurallara uymama' : 'Kural ihlali', full: true }
                ].filter(Boolean),
                submitText: kind === 'kick' ? 'At' : 'Yasakla'
            });
            if (!values) return;
            reason = values.reason;
            duration = parseInt(values.duration || '0', 10) || 0;
        }
        try {
            const data = await api(`/api/players/${server.id}/action`, { method: 'POST', body: { action: kind, name, reason, duration } });
            toast(data.response ? String(data.response).slice(0, 200) : 'Komut gönderildi.', 'success');
            setTimeout(loadLive, 800);
        } catch (error) { toastError(error); }
    }

    async function loadLive() {
        clear(live, loading());
        if (server.state !== 'running') { clear(live, offlineNotice()); return; }
        try {
            const data = await api(`/api/players/${server.id}`);
            clear(live, table([
                { label: 'Oyuncu', render: p => h('strong', {}, p.name) },
                { label: 'Skor', class: 'num', key: 'frags' },
                { label: 'Süre', class: 'nowrap', key: 'time' },
                { label: '', class: 'actions', render: p => h('div', { class: 'btn-group', style: { justifyContent: 'flex-end', flexWrap: 'nowrap' } },
                    btn('Tokatla', { size: 'xs', onClick: () => action(p.name, 'slap') }),
                    btn('Öldür', { size: 'xs', onClick: () => action(p.name, 'slay') }),
                    btn('At', { size: 'xs', variant: 'danger', onClick: () => action(p.name, 'kick') }),
                    btn('Yasakla', { size: 'xs', variant: 'danger', onClick: () => action(p.name, 'ban') })) }
            ], data.players || [], { empty: 'Şu anda sunucuda oyuncu yok.' }));
        } catch (error) { clear(live, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadBoard() {
        try {
            const data = await api(`/api/players/${server.id}/stats`);
            if (!data.enabled) {
                clear(board, h('div', { class: 'card-body' }, h('p', { class: 'text-2' }, data.message || 'İstatistik tablosu bulunamadı.'),
                    h('p', { class: 'small muted mt-8' }, 'csstats_mysql / statsx_sql eklentisini etkinleştirdiğinizde sıralama burada görünür. Veritabanı bilgileri sql.cfg dosyasına otomatik yazılır.')));
                return;
            }
            clear(board, table([
                { label: '#', class: 'num', key: 'rank' },
                { label: 'Oyuncu', render: s => h('strong', {}, s.name) },
                { label: 'Öldürme', class: 'num', key: 'kills' },
                { label: 'Ölüm', class: 'num', key: 'deaths' },
                { label: 'K/D', class: 'num', key: 'kd' },
                { label: 'Kafadan', class: 'num', key: 'hs' },
                { label: 'İsabet', class: 'num', key: 'accuracy' }
            ], data.stats || [], { empty: 'Henüz istatistik yok.' }));
        } catch (error) { clear(board, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    async function loadHistory() {
        try {
            const data = await api(`/api/players/${server.id}/history`);
            clear(historyBox, table([
                { label: 'Oyuncu', render: r => h('strong', {}, r.name) },
                { label: 'SteamID', render: r => h('span', { class: 'mono small' }, r.steamid) },
                { label: 'Son görülme', class: 'nowrap small muted', key: 'lastSeen' }
            ], data.history || [], { empty: 'Bağlantı geçmişi bulunamadı (loglama açık olmalı).' }));
        } catch (error) { clear(historyBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    append(panel, 
        card({ title: 'Oyundaki oyuncular', iconName: 'users', actions: [btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: loadLive })], bodyClass: 'tight', body: live }),
        h('div', { class: 'grid grid-2' },
            card({ title: 'Sıralama (MySQL)', iconName: 'activity', bodyClass: 'tight', body: board }),
            card({ title: 'Son bağlananlar', iconName: 'clock', bodyClass: 'tight', body: historyBox })));
    loadLive();
    loadBoard();
    loadHistory();
}

// ---------------------------------------------------------------------------
//  Admins & bans
// ---------------------------------------------------------------------------

export function adminsTab({ server, panel }) {
    const adminsBox = h('div', {}, loading());
    const bansBox = h('div', {}, loading());

    async function load() {
        try {
            const data = await api(`/api/admins/${server.id}`);
            if (data.offline) { clear(adminsBox, offlineNotice()); clear(bansBox, ''); return; }
            clear(adminsBox, table([
                { label: 'Kimlik', render: a => h('span', { class: 'mono' }, a.auth) },
                { label: 'Yetkiler', render: a => h('span', { class: 'mono small' }, a.access) },
                { label: 'Giriş', render: a => (a.flags.includes('c') ? 'SteamID' : a.flags.includes('d') ? 'IP' : 'Nick + şifre') },
                { label: 'Not', render: a => h('span', { class: 'small muted' }, a.raw.includes(';') ? a.raw.split(';').slice(1).join(';').trim() : '') },
                { label: '', class: 'actions', render: a => btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'Kaldır', onClick: async () => {
                    if (!(await confirmDialog({ title: 'Yetkili kaldırılsın mı?', message: `${a.auth} users.ini dosyasından silinecek.`, confirmText: 'Kaldır', danger: true }))) return;
                    try { await api(`/api/admins/${server.id}/delete`, { method: 'POST', body: { auth: a.auth } }); toast('Yetkili kaldırıldı.', 'success'); load(); } catch (error) { toastError(error); }
                } }) }
            ], data.admins, { empty: 'users.ini dosyasında yetkili yok.' }));
            clear(bansBox, table([
                { label: 'Hedef', render: b => h('span', { class: 'mono' }, b.type === 'IP' ? b.ip : b.steamId) },
                { label: 'Tür', key: 'type' },
                { label: 'Süre', render: b => (Number(b.duration) === 0 ? 'Kalıcı' : `${b.duration} dk`) },
                { label: '', class: 'actions', render: b => btn('Kaldır', { size: 'xs', onClick: async () => {
                    try { await api(`/api/admins/${server.id}/unban`, { method: 'POST', body: { target: b.type === 'IP' ? b.ip : b.steamId, isIp: b.type === 'IP' } }); toast('Yasak kaldırıldı.', 'success'); load(); } catch (error) { toastError(error); }
                } }) }
            ], data.bans, { empty: 'Kayıtlı yasak yok.' }));
        } catch (error) { clear(adminsBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const addAdmin = () => formDialog({
        title: 'Yetkili ekle',
        fields: [
            { name: 'type', label: 'Giriş tipi', type: 'select', value: 'ce', options: [{ value: 'ce', label: 'SteamID (şifresiz)' }, { value: 'a', label: 'Nick + şifre' }, { value: 'de', label: 'IP adresi' }] },
            { name: 'auth', label: 'SteamID / Nick / IP', placeholder: 'STEAM_0:1:12345', required: true },
            { name: 'password', label: 'Şifre (yalnızca nick girişi)', placeholder: 'setinfo _pw ile kullanılır' },
            { name: 'access', label: 'Yetki bayrakları', value: 'abcdefghijklmnopqrstu', help: 'Tam yetki: abcdefghijklmnopqrstu · Sadece kick/ban: bcd' },
            { name: 'comment', label: 'Not', placeholder: 'Örn. Kurucu', full: true }
        ],
        submitText: 'Ekle',
        onSubmit: values => api(`/api/admins/${server.id}/add`, { method: 'POST', body: { auth: values.auth.trim(), password: values.type === 'a' ? values.password : '', access: values.access.trim(), flags: values.type, comment: values.comment } })
    }).then(result => { if (result) { toast('Yetkili eklendi ve yeniden yüklendi.', 'success'); load(); } });

    const addBan = () => formDialog({
        title: 'Yasak ekle',
        fields: [
            { name: 'kind', label: 'Tür', type: 'select', value: 'steam', options: [{ value: 'steam', label: 'SteamID' }, { value: 'ip', label: 'IP adresi' }] },
            { name: 'target', label: 'SteamID veya IP', placeholder: 'STEAM_0:1:12345 veya 1.2.3.4', required: true },
            { name: 'duration', label: 'Süre (dakika, 0 = kalıcı)', type: 'number', value: '0', min: 0 }
        ],
        submitText: 'Yasakla',
        onSubmit: values => {
            if (server.state !== 'running') throw new Error('Yasak eklemek için sunucu çalışıyor olmalı.');
            return api(`/api/admins/${server.id}/ban`, { method: 'POST', body: { target: values.target.trim(), duration: values.duration, isIp: values.kind === 'ip' } });
        }
    }).then(result => { if (result) { toast('Yasak eklendi.', 'success'); load(); } });

    panel.appendChild(h('div', { class: 'grid grid-2' },
        card({ title: 'Yetkililer (users.ini)', iconName: 'shield', actions: [btn('Yetkili ekle', { size: 'sm', variant: 'primary', iconName: 'plus', onClick: addAdmin })], bodyClass: 'tight', body: adminsBox }),
        card({ title: 'Yasaklar', iconName: 'lock', actions: [btn('Yasak ekle', { size: 'sm', variant: 'primary', iconName: 'plus', onClick: addBan })], bodyClass: 'tight', body: bansBox })));
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

    const domainInput = input({ value: info.domain || '', placeholder: 'www.sunucum.com', autocomplete: 'off' });
    const saveDomain = btn('Kaydet', { variant: 'primary' });
    saveDomain.addEventListener('click', () => withBusy(saveDomain, async () => {
        try {
            const data = await api(`${base}/domain`, { method: 'PUT', body: { domain: domainInput.value.trim() } });
            info = data.site;
            toast(info.domain ? `${info.domain} bu siteye bağlandı. DNS kaydınızı PHP sunucusuna yönlendirin.` : 'Özel alan adı kaldırıldı.', 'success');
            paintOverview();
        } catch (error) { toastError(error); }
    }));

    const overview = h('div');
    function paintOverview() {
        clear(overview, h('div', { class: 'grid grid-2' },
            card({
                title: 'Siteniz yayında', iconName: 'globe',
                actions: [h('a', { class: 'btn btn-sm btn-primary', href: info.domainUrl || info.url, target: '_blank', rel: 'noopener' }, icon('external', 'icon-sm'), 'Siteyi aç')],
                body: h('dl', { class: 'kv' },
                    h('dt', {}, 'Adres'), h('dd', {}, copyable(info.url)),
                    info.domainUrl ? [h('dt', {}, 'Alan adı'), h('dd', {}, copyable(info.domainUrl))] : null,
                    h('dt', {}, 'PHP'), h('dd', {}, `PHP ${info.phpVersion} · mysqli, PDO, GD, zip, intl`),
                    h('dt', {}, 'Kullanım'), h('dd', {}, `${fmtBytes(info.usage.bytes)} · ${info.usage.files} dosya`),
                    h('dt', {}, 'Veritabanı'), h('dd', {}, h('span', { class: 'small text-2' }, 'Kodunuzda '), h('code', {}, 'panel_db()'), h('span', { class: 'small text-2' }, ' ile hazır PDO bağlantısı'))),
                footer: [btn('İzinleri onar', { size: 'sm', variant: 'ghost', iconName: 'refresh', onClick: async e => withBusy(e.currentTarget, async () => {
                    try { const d = await api(`${base}/repair`, { method: 'POST' }); toast(d.message, 'success'); } catch (error) { toastError(error); }
                }) })]
            }),
            card({
                title: 'Özel alan adı', iconName: 'link',
                sub: 'Kendi alan adınızı sitenize bağlayın.',
                body: h('div', { class: 'form-stack' },
                    h('div', { class: 'input-group' }, domainInput, saveDomain),
                    h('p', { class: 'small muted' }, 'Alan adınızın A kaydını PHP sunucusunun IP adresine yönlendirin. Boş bırakıp kaydederseniz bağlantı kaldırılır.'))
            })));
    }
    paintOverview();

    const templates = card({
        title: 'Hazır şablonlar', iconName: 'layers', sub: 'Tek tıkla profesyonel bir sunucu sitesi kurun.',
        body: h('div', { class: 'grid grid-2' }, info.templates.map(t => h('div', { class: 'card', style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' } },
            h('h3', {}, t.name), h('p', { class: 'small text-2', style: { flex: '1' } }, t.description),
            h('div', { class: 'btn-group' }, btn('Kur', { size: 'sm', variant: 'primary', onClick: async e => {
                const wipe = await confirmDialog({ title: `${t.name} kurulsun mu?`, message: 'Mevcut site dosyalarınız silinip şablon kurulacak.\n\n"Vazgeç" derseniz işlem iptal edilir.', confirmText: 'Siteyi değiştir', danger: true });
                if (!wipe) return;
                const button = e.target.closest('button');
                await withBusy(button, async () => {
                    try { await api(`${base}/template`, { method: 'POST', body: { template: t.id, wipe: true } }); toast('Şablon kuruldu.', 'success'); fm.reload(); } catch (error) { toastError(error); }
                });
            } })))))
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
    const credentials = card({
        title: 'Bağlantı bilgileri', iconName: 'key',
        actions: [
            h('a', { class: 'btn btn-sm', href: `/api/mysql/databases/${enc(resource.database)}/export`, download: '' }, icon('download', 'icon-sm'), 'SQL yedeği indir'),
            dropdown(btn(null, { size: 'sm', iconName: 'more', title: 'Diğer' }), close => h('div', {},
                menuItem('Şifreyi yenile', async () => {
                    close();
                    if (!(await confirmDialog({ title: 'Veritabanı şifresi yenilensin mi?', message: 'Yeni şifre oyun sunucusunun sql.cfg dosyasına ve web sitenizin yapılandırmasına otomatik yazılır. Harici araçlarda kayıtlı eski şifreyi güncellemeniz gerekir.', confirmText: 'Şifreyi yenile' }))) return;
                    try { const d = await api(`/api/mysql/resources/${server.id}/rotate-password`, { method: 'POST' }); resource = { ...resource, ...d.resource }; toast('Şifre yenilendi.', 'success'); if (revealed) passwordEl.textContent = resource.password; } catch (error) { toastError(error); }
                }, { iconName: 'refresh' }),
                menuItem('Hesabı onar', async () => {
                    close();
                    try { const d = await api(`/api/mysql/resources/${server.id}/repair`, { method: 'POST' }); toast(d.message, 'success'); } catch (error) { toastError(error); }
                }, { iconName: 'settings' })))
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
                { label: 'Tablo', render: t => h('button', { class: 'file-name', type: 'button', onClick: () => browseTable(t.name) }, icon('database', 'icon-sm'), h('span', {}, t.name)) },
                { label: 'Satır', class: 'num', render: t => String(t.rows ?? 0) },
                { label: 'Boyut', class: 'num', render: t => fmtBytes(t.size) },
                { label: 'Motor', class: 'small muted', key: 'engine' }
            ], data.tables, { empty: 'Veritabanında tablo yok.' }));
        } catch (error) { clear(tablesBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    function browseTable(name) {
        let offset = 0;
        const body = h('div', {}, loading());
        const pager = h('div', { class: 'left' });
        const prev = btn('Önceki', { size: 'sm', onClick: () => { offset = Math.max(0, offset - 100); load(); } });
        const next = btn('Sonraki', { size: 'sm', onClick: () => { offset += 100; load(); } });
        async function load() {
            clear(body, loading());
            try {
                const data = await api(`/api/mysql/databases/${enc(resource.database)}/tables/${enc(name)}/data?limit=100&offset=${offset}`);
                clear(body, table(data.columns.map(c => ({ label: c, render: r => (r[c] === null ? h('span', { class: 'muted' }, 'NULL') : String(r[c]).slice(0, 300)) })), data.rows, { empty: 'Tablo boş.' }));
                pager.textContent = data.total ? `${offset + 1}-${Math.min(offset + data.rows.length, data.total)} / ${data.total}` : '0 kayıt';
                prev.disabled = offset <= 0;
                next.disabled = offset + data.rows.length >= data.total;
            } catch (error) { clear(body, errorBox(error)); }
        }
        openModal({ title: `${resource.database}.${name}`, size: 'xl', bodyClass: 'flush', body, footer: [pager, prev, next] });
        load();
    }

    const sql = h('textarea', { class: 'textarea code', rows: 6, spellcheck: 'false', placeholder: 'SELECT * FROM csstats ORDER BY kills DESC LIMIT 20;', 'aria-label': 'SQL sorgusu' });
    const result = h('div');
    const runBtn = btn('Çalıştır', { variant: 'primary', iconName: 'play' });
    const run = () => withBusy(runBtn, async () => {
        const query = sql.value.trim();
        if (!query) return;
        if (/^\s*(drop|truncate|delete|alter)\b/i.test(query) && !(await confirmDialog({ title: 'Veri değiştiren sorgu', message: 'Bu sorgu veriyi kalıcı olarak değiştirebilir veya silebilir. Devam edilsin mi?', confirmText: 'Çalıştır', danger: true }))) return;
        clear(result, loading('Sorgu çalışıyor…'));
        try {
            const data = await api('/api/mysql/query', { method: 'POST', body: { database: resource.database, sql: query } });
            if (!data.columns.length) {
                clear(result, h('div', { class: 'form-success' }, `${data.message || 'Sorgu çalıştı.'} (${data.elapsedMs} ms)`));
                loadTables();
                return;
            }
            clear(result,
                h('p', { class: 'small muted', style: { marginBottom: '8px' } }, `${data.rowCount} satır · ${data.elapsedMs} ms${data.truncated ? ' · ilk 1000 satır gösteriliyor' : ''}`),
                h('div', { class: 'card', style: { maxHeight: '420px', overflow: 'auto' } }, table(data.columns.map(c => ({ label: c, render: r => (r[c] === null ? h('span', { class: 'muted' }, 'NULL') : String(r[c]).slice(0, 300)) })), data.rows, { empty: 'Sonuç yok.' })));
        } catch (error) { clear(result, h('div', { class: 'form-error' }, error.message)); }
    });
    runBtn.addEventListener('click', run);
    sql.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

    append(panel, 
        h('div', { class: 'grid grid-2' }, credentials,
            card({ title: 'Tablolar', iconName: 'list', actions: [btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: loadTables })], bodyClass: 'tight', body: tablesBox })),
        card({ title: 'SQL sorgusu', iconName: 'terminal', sub: 'Sorgular yalnızca bu sunucunun veritabanında, kendi kullanıcınızla çalışır. Ctrl+Enter ile çalıştırın.', body: h('div', { class: 'form-stack' }, sql, h('div', { class: 'row' }, runBtn), result) }));
    loadTables();
}

// ---------------------------------------------------------------------------
//  FastDL
// ---------------------------------------------------------------------------

export function fastdlTab({ server, panel }) {
    const listBox = h('div', {}, loading());
    const log = h('pre', { class: 'log-box short', hidden: true });

    function flatten(items, depth = 0, out = []) {
        items.forEach(item => {
            out.push({ ...item, depth });
            if (item.children) flatten(item.children, depth + 1, out);
        });
        return out;
    }

    async function load() {
        clear(listBox, loading());
        try {
            const data = await api(`/api/fastdl/${server.port}/files`);
            const rows = flatten(data.files || []);
            const files = rows.filter(r => !r.isDir);
            const total = files.reduce((s, f) => s + f.size, 0);
            clear(listBox,
                h('div', { class: 'card-body', style: { borderBottom: '1px solid var(--border)' } },
                    h('div', { class: 'row' }, badge(`${files.length} dosya`, 'accent'), badge(fmtBytes(total)))),
                table([
                    { label: 'Dosya', render: r => h('span', { class: `file-name ${r.isDir ? 'is-dir' : ''}`, style: { paddingLeft: `${r.depth * 18}px` } }, icon(r.isDir ? 'folder' : 'file', 'icon-sm'), h('span', { class: 'truncate' }, r.name)) },
                    { label: 'Boyut', class: 'num', render: r => (r.isDir ? '' : fmtBytes(r.size)) },
                    { label: '', class: 'actions', render: r => (r.isDir ? '' : btn(null, { size: 'xs', variant: 'danger', iconName: 'trash', title: 'FastDL kopyasını sil', onClick: async () => {
                        try { await api(`/api/fastdl/${server.port}/file?path=${enc(r.path)}`, { method: 'DELETE' }); toast('Silindi.', 'success', 1800); load(); } catch (error) { toastError(error); }
                    } })) }
                ], rows, { empty: 'FastDL klasörü boş. Eşitleme başlatın.' }));
        } catch (error) { clear(listBox, h('div', { class: 'card-body' }, errorBox(error))); }
    }

    const syncBtn = btn('Şimdi eşitle', { variant: 'primary', size: 'sm', iconName: 'refresh' });
    syncBtn.addEventListener('click', () => withBusy(syncBtn, async () => {
        log.hidden = false;
        log.textContent = 'maps, models, sound, sprites, gfx eşitleniyor…';
        try {
            const data = await api(`/api/fastdl/${server.port}/sync`, { method: 'POST', body: {}, timeoutMs: 600000 });
            log.textContent = (data.log || []).filter(l => !l.startsWith('SKIP')).join('\n') || data.message;
            toast(data.message, data.success ? 'success' : 'warning');
            load();
        } catch (error) { log.textContent = error.message; toastError(error); }
    }));

    append(panel, 
        card({
            title: 'Hızlı indirme (FastDL)', iconName: 'download',
            sub: 'Oyuncular özel haritaları, modelleri ve sesleri bu adresten hızlıca indirir. Adres server.cfg dosyasına otomatik yazılır.',
            actions: [syncBtn],
            body: h('div', { class: 'form-stack' },
                h('dl', { class: 'kv' }, h('dt', {}, 'sv_downloadurl'), h('dd', {}, copyable(server.fastdl.url))),
                h('p', { class: 'small muted' }, 'Yüklediğiniz harita ve dosyalar otomatik eşitlenir. Güvenlik gereği .cfg/.ini gibi yapılandırma dosyaları asla FastDL\'e kopyalanmaz.'),
                log)
        }),
        card({ title: 'FastDL içeriği', iconName: 'folder', actions: [btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: load })], bodyClass: 'tight', body: listBox }));
    load();
}

// ---------------------------------------------------------------------------
//  Settings (server.cfg)
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

export async function settingsTab({ server, panel }) {
    panel.appendChild(loading());
    let settings;
    try {
        settings = (await api(`/api/servers/${server.id}/settings`)).settings;
    } catch (error) {
        clear(panel, error.status === 409 || /running|çalış/i.test(error.message) ? card({ body: offlineNotice('Ayarları okumak için sunucunun çalışıyor olması gerekir.') }) : errorBox(error));
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
        return h('div', { class: 'stack', style: { gap: '12px' } }, h('h3', { class: 'text-2' }, group.title), grid);
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
    saveCfg.addEventListener('click', () => withBusy(saveCfg, async () => {
        try {
            await api(`/api/files/${server.id}/edit`, { method: 'POST', body: { file: currentFile, content: editor.value } });
            toast(`${currentFile} kaydedildi.`, 'success', 2000);
        } catch (error) { toastError(error); }
    }));
    editor.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (currentFile) saveCfg.click(); } });
    api(`/api/servers/${server.id}/configs`).then(data => {
        clear(list, (data.configs || []).map(path => {
            const b = h('button', { type: 'button', title: path, onClick: async () => {
                list.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
                editorPath.textContent = path;
                editor.disabled = true;
                editor.value = 'Yükleniyor…';
                try {
                    const d = await api(`/api/files/${server.id}/view?file=${enc(path)}`);
                    currentFile = path;
                    editor.value = d.content;
                    editor.disabled = false;
                    saveCfg.disabled = false;
                    editor.focus();
                } catch (error) { editor.value = error.message; }
            } }, h('span', {}, path.split('/').pop()), path.includes('/') ? h('small', {}, path.split('/').slice(0, -1).join('/')) : null);
            return b;
        }));
        if (!data.configs.length) clear(list, h('div', { class: 'small muted', style: { padding: '10px' } }, 'Yapılandırma dosyası bulunamadı.'));
    }).catch(error => clear(list, h('div', { class: 'small text-danger', style: { padding: '10px' } }, error.message)));

    append(panel, 
        card({ title: 'Sunucu ayarları (server.cfg)', iconName: 'sliders', sub: 'Değişiklikler dosyaya yazılır ve sunucu çalışıyorsa anında uygulanır.', body: h('div', { class: 'stack' }, sections), footer: [saveBtn] }),
        card({ title: 'Hızlı yapılandırma düzenleyici', iconName: 'edit', bodyClass: 'tight',
            body: h('div', { class: 'split' }, list, h('div', { class: 'pane' }, h('div', { class: 'pane-head' }, editorPath, saveCfg), editor)) }));
}
