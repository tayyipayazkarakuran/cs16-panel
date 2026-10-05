// Reusable file manager used for game server files (cstrike) and PHP sites.
import {
    h, clear, icon, btn, table, fmtBytes, fmtDateTime, toast, toastError, confirmDialog, promptDialog,
    openModal, uploadWithProgress, withBusy, loading, dropdown, menuItem
} from '../core.js';

const EDITABLE = ['.cfg', '.ini', '.txt', '.sma', '.inc', '.lst', '.rc', '.php', '.html', '.htm', '.css', '.js', '.json', '.xml', '.md', '.env', '.yml', '.yaml', '.sql', '.conf', '.htaccess', '.log', '.res', '.gam'];

export function isEditable(name) {
    const lower = String(name || '').toLowerCase();
    return EDITABLE.some(ext => lower.endsWith(ext)) || lower === '.htaccess';
}

function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function createBatches(files, maxFiles, maxBytes) {
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const file of files) {
        if (batch.length && (batch.length >= maxFiles || bytes + file.size > maxBytes)) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }
        batch.push(file);
        bytes += file.size;
    }
    if (batch.length) batches.push(batch);
    return batches;
}

/** Full-screen code editor modal. Ctrl/Cmd+S saves, Tab inserts a tab. */
export function openEditor({ title, load, save, readOnly = false }) {
    const area = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': title, readOnly: true, value: 'Yükleniyor…' });
    const status = h('span', {}, '');
    let dirty = false;
    let original = '';
    const saveBtn = btn('Kaydet', { variant: 'primary', iconName: 'check', disabled: true });
    const doSave = () => withBusy(saveBtn, async () => {
        try {
            await save(area.value);
            original = area.value;
            dirty = false;
            status.textContent = `Kaydedildi · ${new Date().toLocaleTimeString('tr-TR')}`;
            toast('Dosya kaydedildi.', 'success', 2000);
        } catch (error) {
            toastError(error);
        }
    });
    saveBtn.addEventListener('click', doSave);
    area.addEventListener('input', () => {
        dirty = area.value !== original;
        status.textContent = dirty ? 'Kaydedilmemiş değişiklik var' : '';
    });
    area.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!readOnly) doSave(); }
        if (e.key === 'Tab' && !e.shiftKey && !readOnly) {
            e.preventDefault();
            const { selectionStart: start, selectionEnd: end } = area;
            area.setRangeText('\t', start, end, 'end');
            area.dispatchEvent(new Event('input'));
        }
    });
    const modal = openModal({
        title, size: 'xl', bodyClass: 'flush',
        body: area,
        footer: [h('div', { class: 'left' }, icon('info', 'icon-sm'), status, h('span', { class: 'muted' }, 'Ctrl+S ile kaydet')),
            btn('Kapat', { variant: 'ghost', onClick: async () => {
                if (dirty && !(await confirmDialog({ title: 'Değişiklikler kaydedilmedi', message: 'Kaydetmeden kapatmak istiyor musunuz?', confirmText: 'Kapat', danger: true }))) return;
                modal.close();
            } }),
            readOnly ? null : saveBtn],
        closeOnBackdrop: false
    });
    Promise.resolve(load()).then(content => {
        original = content;
        area.value = content;
        area.readOnly = readOnly;
        saveBtn.disabled = readOnly;
        area.focus();
        area.setSelectionRange(0, 0);
        area.scrollTop = 0;
    }).catch(error => { area.value = `Dosya açılamadı: ${error.message}`; });
    return modal;
}

export function createFileManager(adapter) {
    let currentPath = adapter.initialPath || '';
    let activeUpload = null;
    let busy = false;

    const crumbs = h('nav', { class: 'breadcrumb', 'aria-label': 'Klasör yolu' });
    const listBox = h('div');
    const transfer = h('div', { class: 'transfer', hidden: true, 'aria-live': 'polite' });
    const fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    const folderInput = h('input', { type: 'file', hidden: true, webkitdirectory: true, multiple: true });
    const zipInput = h('input', { type: 'file', hidden: true, accept: '.zip,application/zip' });

    const uploadMenu = dropdown(btn('Yükle', { iconName: 'upload', size: 'sm', variant: 'primary' }), close => h('div', {},
        menuItem('Dosya yükle', () => { close(); fileInput.click(); }, { iconName: 'file' }),
        menuItem('Klasör yükle', () => { close(); folderInput.click(); }, { iconName: 'folder' }),
        adapter.zipUploadUrl ? menuItem('ZIP yükle ve aç', () => { close(); zipInput.click(); }, { iconName: 'archive' }) : null));

    const toolbar = h('div', { class: 'fm-toolbar' },
        crumbs,
        h('div', { class: 'btn-group' },
            btn('Yeni dosya', { size: 'sm', iconName: 'filePlus', onClick: newFile }),
            btn('Yeni klasör', { size: 'sm', iconName: 'folderPlus', onClick: newFolder }),
            uploadMenu,
            btn(null, { size: 'sm', iconName: 'refresh', title: 'Yenile', onClick: () => load(currentPath) })),
        fileInput, folderInput, zipInput);

    const root = h('div', {}, toolbar, transfer, listBox);

    // Drag & drop files onto the list.
    root.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); root.classList.add('dropzone-active'); } });
    root.addEventListener('dragleave', e => { if (!root.contains(e.relatedTarget)) root.classList.remove('dropzone-active'); });
    root.addEventListener('drop', e => {
        root.classList.remove('dropzone-active');
        if (!e.dataTransfer || !e.dataTransfer.files.length) return;
        e.preventDefault();
        uploadFiles([...e.dataTransfer.files], false);
    });

    fileInput.addEventListener('change', () => { const files = [...fileInput.files]; fileInput.value = ''; if (files.length) uploadFiles(files, false); });
    folderInput.addEventListener('change', () => { const files = [...folderInput.files]; folderInput.value = ''; if (files.length) uploadFiles(files, true); });
    zipInput.addEventListener('change', () => { const file = zipInput.files[0]; zipInput.value = ''; if (file) uploadZip(file); });

    function join(name) {
        return currentPath ? `${currentPath}/${name}` : name;
    }

    function paintCrumbs() {
        const parts = currentPath.split('/').filter(Boolean);
        const items = [h('button', { type: 'button', onClick: () => load('') }, adapter.rootLabel || '/')];
        let acc = '';
        parts.forEach(part => {
            acc = acc ? `${acc}/${part}` : part;
            const target = acc;
            items.push(h('span', { class: 'sep' }, '/'), h('button', { type: 'button', onClick: () => load(target) }, part));
        });
        clear(crumbs, items);
    }

    async function load(path = currentPath) {
        currentPath = path;
        paintCrumbs();
        clear(listBox, loading('Dosyalar yükleniyor…'));
        try {
            const data = await adapter.list(path);
            renderList(data.files || []);
        } catch (error) {
            clear(listBox, h('div', { class: 'table-empty text-danger' }, error.message));
        }
    }

    function actionsFor(file) {
        const items = [];
        if (!file.isDir && isEditable(file.name)) items.push(btn(null, { size: 'xs', iconName: 'edit', title: 'Düzenle', onClick: () => edit(file) }));
        if (!file.isDir && adapter.openUrl) {
            const url = adapter.openUrl(file);
            if (url) items.push(h('a', { class: 'btn btn-xs btn-icon', href: url, target: '_blank', rel: 'noopener', title: 'Tarayıcıda aç' }, icon('external', 'icon-sm')));
        }
        if (!file.isDir && adapter.downloadUrl) items.push(h('a', { class: 'btn btn-xs btn-icon', href: adapter.downloadUrl(file.path), title: 'İndir', download: file.name }, icon('download', 'icon-sm')));
        const more = dropdown(btn(null, { size: 'xs', iconName: 'more', title: 'Diğer işlemler' }), close => h('div', {},
            menuItem('Yeniden adlandır / taşı', () => { close(); rename(file); }, { iconName: 'edit' }),
            (!file.isDir && /\.zip$/i.test(file.name) && adapter.extract) ? menuItem('Buraya çıkar', () => { close(); extract(file); }, { iconName: 'archive' }) : null,
            h('div', { class: 'sep' }),
            menuItem('Sil', () => { close(); remove(file); }, { iconName: 'trash', danger: true })));
        items.push(more);
        return h('div', { class: 'btn-group', style: { justifyContent: 'flex-end', flexWrap: 'nowrap', gap: '6px' } }, items);
    }

    function renderList(files) {
        const rows = [];
        if (currentPath) rows.push({ name: '..', isDir: true, parent: true });
        rows.push(...files);
        clear(listBox, table([
            { label: 'Ad', render: f => {
                const content = [icon(f.isDir ? 'folder' : 'file'), h('span', { class: 'truncate' }, f.parent ? '.. (üst klasör)' : f.name)];
                if (f.isDir) return h('button', { class: 'file-name is-dir', type: 'button', onClick: () => load(f.parent ? currentPath.split('/').slice(0, -1).join('/') : f.path) }, content);
                return isEditable(f.name)
                    ? h('button', { class: 'file-name', type: 'button', onClick: () => edit(f) }, content)
                    : h('span', { class: 'file-name' }, content);
            } },
            { label: 'Boyut', class: 'num nowrap', render: f => (f.isDir ? '' : fmtBytes(f.size)) },
            { label: 'Değiştirilme', class: 'nowrap small muted hide-sm', render: f => (f.parent ? '' : fmtDateTime(f.mtime)) },
            { label: '', class: 'actions', render: f => (f.parent ? '' : actionsFor(f)) }
        ], rows, { empty: 'Bu klasör boş. Dosyaları buraya sürükleyip bırakabilirsiniz.' }));
    }

    function edit(file) {
        openEditor({
            title: file.path,
            load: () => adapter.view(file.path),
            save: content => adapter.save(file.path, content)
        });
    }

    async function newFile() {
        const name = await promptDialog({ title: 'Yeni dosya', label: 'Dosya adı', placeholder: adapter.newFilePlaceholder || 'ornek.cfg' });
        if (!name) return;
        if (/[\\/]/.test(name)) return toast('Dosya adı / içeremez.', 'error');
        const path = join(name.trim());
        try {
            await adapter.save(path, adapter.newFileTemplate ? adapter.newFileTemplate(name) : '');
            await load(currentPath);
            edit({ path, name });
        } catch (error) { toastError(error); }
    }

    async function newFolder() {
        const name = await promptDialog({ title: 'Yeni klasör', label: 'Klasör adı' });
        if (!name) return;
        try {
            await adapter.mkdir(currentPath, name.trim());
            toast('Klasör oluşturuldu.', 'success', 2000);
            load(currentPath);
        } catch (error) { toastError(error); }
    }

    async function rename(file) {
        const target = await promptDialog({ title: 'Yeniden adlandır / taşı', label: 'Yeni yol', value: file.path, help: 'Klasörler arası taşımak için tam yolu yazın.' });
        if (!target || target === file.path) return;
        try {
            await adapter.rename(file.path, target.trim().replace(/^\/+/, ''));
            toast('Taşındı.', 'success', 2000);
            load(currentPath);
        } catch (error) { toastError(error); }
    }

    async function remove(file) {
        const ok = await confirmDialog({
            title: file.isDir ? 'Klasör silinsin mi?' : 'Dosya silinsin mi?',
            message: `"${file.path}" ${file.isDir ? 've içindeki her şey ' : ''}kalıcı olarak silinecek.`,
            confirmText: 'Sil', danger: true
        });
        if (!ok) return;
        try {
            await adapter.remove(file.path);
            toast('Silindi.', 'success', 2000);
            load(currentPath);
        } catch (error) { toastError(error); }
    }

    async function extract(file) {
        const t = toast(`${file.name} çıkarılıyor…`, 'info', 0);
        try {
            const result = await adapter.extract(file.path, currentPath);
            toast(result.message || 'Arşiv çıkarıldı.', 'success');
            load(currentPath);
        } catch (error) { toastError(error); }
        finally { t.remove(); }
    }

    // ---- Uploads with progress -------------------------------------------

    let state = null;
    let timer = null;

    function paintTransfer() {
        if (!state) return;
        const pct = Math.max(0, Math.min(100, state.percent || 0));
        transfer.hidden = false;
        transfer.className = `transfer ${state.mode ? `is-${state.mode}` : ''}`.trim();
        clear(transfer,
            h('div', { class: 'head' },
                h('div', {}, h('strong', {}, state.status), h('div', { class: 'small muted' }, state.detail)),
                btn(activeUpload ? 'İptal' : 'Kapat', { size: 'xs', variant: activeUpload ? 'danger' : 'ghost', onClick: () => {
                    if (activeUpload) { state.cancelled = true; activeUpload.abort(); }
                    else { transfer.hidden = true; state = null; }
                } })),
            h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, h('div', { style: { width: `${pct}%` } })),
            h('div', { class: 'metrics' },
                h('span', {}, `%${Math.round(pct)}`),
                h('span', {}, `${state.done} / ${state.total} dosya`),
                h('span', {}, `${fmtBytes(state.sent)} / ${fmtBytes(state.bytes)}`),
                h('span', {}, state.speed > 0 ? `${fmtBytes(state.speed)}/sn` : '—'),
                h('span', {}, formatElapsed(Date.now() - state.startedAt))),
            state.message ? h('div', { class: 'small text-2' }, state.message) : null);
    }

    function begin(total, bytes, detail) {
        state = { status: 'Yükleme hazırlanıyor', detail, message: '', mode: '', total, done: 0, bytes, sent: 0, speed: 0, percent: 0, startedAt: Date.now(), cancelled: false };
        busy = true;
        clearInterval(timer);
        timer = setInterval(paintTransfer, 500);
        paintTransfer();
    }

    function finish(mode, status, message) {
        clearInterval(timer);
        activeUpload = null;
        busy = false;
        Object.assign(state, { mode, status, message, speed: 0, percent: mode === 'success' ? 100 : state.percent });
        paintTransfer();
    }

    async function uploadFiles(files, keepPaths) {
        if (busy) return toast('Devam eden bir yükleme var.', 'warning');
        const bytes = files.reduce((s, f) => s + f.size, 0);
        const single = files.length === 1 && !keepPaths;
        const batches = single ? [files] : createBatches(files, adapter.batchFiles || 24, adapter.batchBytes || 64 * 1024 * 1024);
        begin(files.length, bytes, single ? files[0].name : `${files.length} dosya · ${batches.length} parça`);
        let done = 0;
        let sentBefore = 0;
        const problems = [];
        try {
            for (let i = 0; i < batches.length; i++) {
                if (state.cancelled) throw Object.assign(new Error('Yükleme iptal edildi.'), { name: 'UploadCancelledError' });
                const batch = batches[i];
                const batchBytes = batch.reduce((s, f) => s + f.size, 0);
                const form = new FormData();
                let url;
                if (single) {
                    form.append(adapter.pathField || 'path', currentPath);
                    form.append('file', batch[0]);
                    url = adapter.uploadUrl;
                } else {
                    form.append('basePath', currentPath);
                    batch.forEach(file => {
                        form.append('files', file);
                        form.append('relativePaths', keepPaths ? (file.webkitRelativePath || file.name) : file.name);
                    });
                    url = adapter.uploadFolderUrl;
                }
                Object.assign(state, { mode: '', status: batches.length > 1 ? `Parça ${i + 1}/${batches.length} gönderiliyor` : 'Gönderiliyor' });
                const data = await uploadWithProgress(url, form, {
                    register: handle => { activeUpload = handle; },
                    onProgress: loaded => {
                        const sent = sentBefore + loaded;
                        const elapsed = Math.max(1, (Date.now() - state.startedAt) / 1000);
                        Object.assign(state, { sent, percent: bytes ? sent / bytes * 100 : 0, speed: sent / elapsed });
                    },
                    onUploaded: () => Object.assign(state, { mode: 'processing', status: 'Sunucuda yazılıyor', message: adapter.processingMessage || 'Dosyalar güvenli şekilde yazılıyor.' })
                });
                done += Number.isInteger(data.uploaded) ? data.uploaded : batch.length;
                sentBefore += batchBytes;
                if (Array.isArray(data.errors)) problems.push(...data.errors.map(e => e.error || String(e)));
                if (data.warning) problems.push(data.warning);
                Object.assign(state, { done, sent: sentBefore, percent: bytes ? sentBefore / bytes * 100 : 100 });
            }
            if (problems.length) finish('warning', `${done}/${files.length} dosya yüklendi`, `${problems.length} uyarı. İlk ayrıntı: ${problems[0]}`);
            else finish('success', 'Yükleme tamamlandı', `${done} dosya ${formatElapsed(Date.now() - state.startedAt)} içinde yazıldı.`);
        } catch (error) {
            finish('error', error.name === 'UploadCancelledError' ? 'Yükleme durduruldu' : 'Yükleme başarısız', `${done}/${files.length} dosya tamamlandı. ${error.message}`);
        } finally {
            load(currentPath);
        }
    }

    async function uploadZip(file) {
        if (busy) return toast('Devam eden bir yükleme var.', 'warning');
        const wipe = adapter.zipWipeAllowed && !currentPath
            ? await confirmDialog({ title: 'ZIP arşivini yükle', message: 'Mevcut site dosyaları silinip arşiv içeriğiyle değiştirilsin mi?\n\n"Vazgeç" seçerseniz dosyalar mevcut içeriğin üzerine eklenir.', confirmText: 'Evet, siteyi değiştir', danger: true })
            : false;
        begin(1, file.size, file.name);
        const form = new FormData();
        form.append('file', file);
        form.append('path', currentPath);
        form.append('wipe', wipe ? 'true' : 'false');
        try {
            const data = await uploadWithProgress(adapter.zipUploadUrl, form, {
                register: handle => { activeUpload = handle; },
                onProgress: loaded => Object.assign(state, { sent: loaded, percent: loaded / file.size * 100, speed: loaded / Math.max(1, (Date.now() - state.startedAt) / 1000) }),
                onUploaded: () => Object.assign(state, { mode: 'processing', status: 'Arşiv açılıyor' })
            });
            state.done = 1;
            finish('success', 'Arşiv açıldı', data.message);
        } catch (error) {
            finish('error', 'Arşiv açılamadı', error.message);
        } finally {
            load(currentPath);
        }
    }

    load(currentPath);
    return { el: root, reload: () => load(currentPath), isBusy: () => busy, abort: () => { if (activeUpload) activeUpload.abort(); clearInterval(timer); } };
}
