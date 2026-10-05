// Core utilities shared by every view: API client, safe DOM builder,
// dialogs, toasts, formatting and the hash router. Nothing here ever
// builds HTML from strings, so user-controlled text cannot inject markup.

export const state = {
    user: null,
    config: null,
    summary: null,
    servers: [],
    serversLoadPromise: null
};

const listeners = new Map();
export function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(handler);
    return () => listeners.get(event).delete(handler);
}
export function emit(event, payload) {
    (listeners.get(event) || []).forEach(handler => {
        try { handler(payload); } catch (e) { console.error(e); }
    });
}

// ---------------------------------------------------------------------------
//  API client
// ---------------------------------------------------------------------------

export class ApiError extends Error {
    constructor(message, { status = 0, code = null, data = null } = {}) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.data = data;
    }
}

/**
 * JSON API call. Session auth uses the HttpOnly cookie only — tokens are
 * never kept in browser storage.
 */
export async function api(path, { method = 'GET', body, form, timeoutMs = 120000, signal } = {}) {
    const headers = {};
    let payload;
    if (form) {
        payload = form;
    } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const controller = new AbortController();
    let requestTimedOut = false;
    const timer = setTimeout(() => { requestTimedOut = true; controller.abort(); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let res;
    try {
        res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: controller.signal });
    } catch (error) {
        if (requestTimedOut) {
            const timeoutError = new ApiError(`İstek ${Math.round(timeoutMs / 1000)} saniye içinde tamamlanamadı. Bağlantınızı kontrol edip tekrar deneyin.`);
            timeoutError.name = 'ApiTimeoutError';
            throw timeoutError;
        }
        if (controller.signal.aborted) {
            const cancelledError = new ApiError('İstek iptal edildi.');
            cancelledError.name = 'RequestCancelledError';
            throw cancelledError;
        }
        throw new ApiError('Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.');
    } finally {
        clearTimeout(timer);
    }

    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) {
        const message = (data && data.error) || (typeof data === 'string' && data.slice(0, 200)) || `İstek başarısız (HTTP ${res.status})`;
        const error = new ApiError(message, { status: res.status, code: data && data.code, data });
        if (res.status === 401 && !path.startsWith('/api/auth/')) emit('session-expired');
        if (res.status === 503 && error.code === 'MAINTENANCE') emit('maintenance', message);
        if (res.status === 403 && error.code === 'ACCOUNT_SUSPENDED') emit('session-expired', message);
        throw error;
    }
    return data;
}

/** XHR upload with byte-level progress (fetch has no upload progress). */
export function uploadWithProgress(url, formData, { onProgress, onUploaded, timeoutMs = 300000, register } = {}) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let uploadCancelled = false;
        if (register) register({ abort: () => { uploadCancelled = true; xhr.abort(); } });
        xhr.open('POST', url);
        xhr.withCredentials = true;
        xhr.timeout = timeoutMs;
        xhr.upload.onprogress = event => { if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total); };
        xhr.upload.onload = () => { if (onUploaded) onUploaded(); };
        xhr.onload = () => {
            let data;
            try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) { return reject(new ApiError(`Sunucu geçersiz yanıt verdi (HTTP ${xhr.status}).`)); }
            if (xhr.status === 401) emit('session-expired');
            if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
            reject(new ApiError(data.error || data.message || `Yükleme başarısız (HTTP ${xhr.status}).`, { status: xhr.status, data }));
        };
        xhr.onerror = () => reject(new ApiError('Ağ bağlantısı kesildi. Yüklenen dosyalar korunur; kalan kısmı yeniden deneyin.'));
        xhr.ontimeout = () => reject(new ApiError(`Yükleme ${Math.round(timeoutMs / 60000)} dakika içinde tamamlanamadı.`));
        xhr.onabort = () => {
            const error = new ApiError(uploadCancelled ? 'Yükleme iptal edildi.' : 'Yükleme tarayıcı tarafından durduruldu.');
            error.name = 'UploadCancelledError';
            reject(error);
        };
        xhr.send(formData);
    });
}

// ---------------------------------------------------------------------------
//  DOM helpers
// ---------------------------------------------------------------------------

/**
 * h('button', { class: 'btn', onClick: fn, disabled: true }, 'Text', child)
 * Strings become text nodes; null/false children are skipped.
 */
export function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
        else if (key === 'dataset') Object.assign(el.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'value') el.value = value;
        else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'readOnly' || key === 'hidden' || key === 'required' || key === 'multiple') el[key] = !!value;
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    append(el, children);
    return el;
}

/** Null-safe append: null/undefined/booleans are skipped (Element.append would print "null"). */
export function append(parent, ...children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false || child === true) continue;
        parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return parent;
}

export function clear(el, ...children) {
    el.replaceChildren();
    return append(el, children);
}

const ICONS = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    cart: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 8H6.2M9 20h.01M18 20h.01',
    wallet: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2zM16 14h.01',
    user: 'M20 21a8 8 0 1 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    gauge: 'M12 14l4-4M3.3 18A10 10 0 1 1 20.7 18',
    bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    menu: 'M3 6h18M3 12h18M3 18h18',
    x: 'M18 6 6 18M6 6l12 12',
    check: 'M20 6 9 17l-5-5',
    plus: 'M12 5v14M5 12h14',
    play: 'M6 4l14 8-14 8z',
    stop: 'M6 6h12v12H6z',
    refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    folderPlus: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v6M9 14h6',
    file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
    filePlus: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M12 12v6M9 15h6',
    archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    terminal: 'M4 17l6-5-6-5M12 19h8',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    puzzle: 'M19 11h-1.5a1.5 1.5 0 0 1 0-3H19V5a1 1 0 0 0-1-1h-3v1.5a1.5 1.5 0 0 1-3 0V4H9a1 1 0 0 0-1 1v3H6.5a1.5 1.5 0 0 0 0 3H8v3h1.5a1.5 1.5 0 0 1 0 3H8v2a1 1 0 0 0 1 1h3v-1.5a1.5 1.5 0 0 1 3 0V20h3a1 1 0 0 0 1-1z',
    map: 'M9 3 3 6v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15',
    crosshair: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
    zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
    database: 'M12 8c5 0 8-1.3 8-3s-3-3-8-3-8 1.3-8 3 3 3 8 3zM4 5v14c0 1.7 3 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3 3 8 3s8-1.3 8-3',
    sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
    alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 1 1 8 0v4',
    key: 'M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.8 7.8 5.5 5.5 0 0 1 7.8-7.8zM15.5 7.5l3 3L22 7l-3-3',
    tag: 'M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8zM7 7h.01',
    megaphone: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
    cpu: 'M4 4h16v16H4zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
    more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    arrowUp: 'M12 19V5M5 12l7-7 7 7',
    arrowDown: 'M12 5v14M19 12l-7 7-7-7',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    receipt: 'M4 2v20l3-2 3 2 3-2 3 2 3-2 1 1V2l-1 1-3-2-3 2-3-2-3 2-3-2zM8 8h8M8 12h8M8 16h5',
    send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'
};

export function icon(name, cls = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `icon ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name] || ICONS.info);
    svg.appendChild(path);
    return svg;
}

export function btn(label, { variant = '', size = '', iconName = null, onClick, type = 'button', title, disabled, attrs = {} } = {}) {
    const classes = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, !label && 'btn-icon'].filter(Boolean).join(' ');
    return h('button', { class: classes, type, onClick, title, 'aria-label': !label ? title : null, disabled, ...attrs },
        iconName ? icon(iconName, size ? 'icon-sm' : '') : null, label || null);
}

/** Run an async action while showing a spinner on the button. */
export async function withBusy(button, fn) {
    if (button) { button.classList.add('is-loading'); button.disabled = true; }
    try {
        return await fn();
    } finally {
        if (button) { button.classList.remove('is-loading'); button.disabled = false; }
    }
}

export function badge(text, variant = '') {
    return h('span', { class: `badge ${variant ? `badge-${variant}` : ''}` }, text);
}

export function card({ title, sub, actions, body, footer, bodyClass = '', id, iconName } = {}) {
    return h('section', { class: 'card', id },
        title ? h('div', { class: 'card-head' },
            h('div', {}, h('h3', {}, iconName ? icon(iconName) : null, title), sub ? h('div', { class: 'sub' }, sub) : null),
            actions ? h('div', { class: 'btn-group' }, actions) : null) : null,
        body !== undefined ? h('div', { class: `card-body ${bodyClass}`.trim() }, body) : null,
        footer ? h('div', { class: 'card-foot' }, footer) : null);
}

export function loading(text = 'Yükleniyor…') {
    return h('div', { class: 'loading-block' }, h('div', { class: 'spinner' }), text);
}

export function emptyState({ iconName = 'info', title, text, action } = {}) {
    return h('div', { class: 'empty' },
        h('div', { class: 'empty-icon' }, icon(iconName, 'icon-lg')),
        title ? h('h3', {}, title) : null,
        text ? h('p', {}, text) : null,
        action || null);
}

export function errorBox(error) {
    return h('div', { class: 'alert alert-danger' }, icon('alert'), h('div', {}, h('strong', {}, 'Bir sorun oluştu'), h('p', {}, error.message || String(error))));
}

export function field(label, control, { help, id } = {}) {
    if (id && control && !control.id) control.id = id;
    return h('div', { class: 'field' }, label ? h('label', { for: control && control.id }, label) : null, control, help ? h('div', { class: 'help' }, help) : null);
}

export function input(attrs = {}) {
    const { class: extra, ...rest } = attrs;
    return h('input', { ...rest, class: `input ${extra || ''}`.trim() });
}

export function select(options, attrs = {}) {
    const el = h('select', { class: 'select', ...attrs });
    options.forEach(o => {
        const opt = typeof o === 'object' ? o : { value: o, label: o };
        el.appendChild(h('option', { value: opt.value, selected: String(opt.value) === String(attrs.value) }, opt.label));
    });
    if (attrs.value !== undefined) el.value = attrs.value;
    return el;
}

export function switchControl(label, checked, onChange) {
    const inputEl = h('input', { type: 'checkbox', checked, onChange: e => onChange(e.target.checked, e.target) });
    return h('label', { class: 'switch' }, inputEl, h('span', { class: 'track' }), label);
}

export function table(columns, rows, { empty = 'Kayıt bulunamadı.', rowAttrs } = {}) {
    const thead = h('thead', {}, h('tr', {}, columns.map(c => h('th', { class: c.class || '' }, c.label || ''))));
    const tbody = h('tbody');
    if (!rows.length) {
        tbody.appendChild(h('tr', {}, h('td', { colspan: columns.length, class: 'table-empty' }, empty)));
    } else {
        rows.forEach((row, i) => {
            const tr = h('tr', rowAttrs ? rowAttrs(row, i) : {});
            columns.forEach(c => {
                const value = c.render ? c.render(row, i) : row[c.key];
                tr.appendChild(h('td', { class: c.class || '' }, value === null || value === undefined ? '—' : value));
            });
            tbody.appendChild(tr);
        });
    }
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody));
}

export function copyButton(text, label = null) {
    return btn(label, {
        size: 'xs', variant: 'ghost', iconName: 'copy', title: 'Kopyala',
        onClick: async e => {
            e.stopPropagation();
            await copyText(text);
        }
    });
}

export function copyable(text) {
    return h('span', { class: 'copyable' }, h('code', { title: text }, text), copyButton(text));
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast('Panoya kopyalandı.', 'success', 1800);
    } catch (_) {
        await promptDialog({ title: 'Kopyala', label: 'Metni seçip kopyalayın', value: text });
    }
}

// ---------------------------------------------------------------------------
//  Toasts & dialogs
// ---------------------------------------------------------------------------

let toastRoot = null;
export function toast(message, type = 'info', duration = 4500) {
    if (!toastRoot) {
        toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(toastRoot);
    }
    const icons = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
    const el = h('div', { class: `toast toast-${type}` }, icon(icons[type] || 'info'), h('div', { class: 'msg' }, message),
        h('button', { type: 'button', 'aria-label': 'Kapat', onClick: () => el.remove() }, icon('x', 'icon-sm')));
    toastRoot.appendChild(el);
    if (duration) setTimeout(() => el.remove(), type === 'error' ? Math.max(duration, 7000) : duration);
    return el;
}

export function toastError(error) {
    toast(error && error.message ? error.message : String(error), 'error');
}

let openModals = 0;
/**
 * Open a modal. Escape/backdrop close it, focus is trapped inside and
 * restored to the opener afterwards.
 */
export function openModal({ title, body, footer, size = '', onClose, closeOnBackdrop = true, bodyClass = '' }) {
    const opener = document.activeElement;
    const closeBtn = btn(null, { variant: 'ghost', iconName: 'x', title: 'Kapat', onClick: () => close() });
    const dialog = h('div', { class: `modal ${size ? `modal-${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-head' }, h('h2', {}, title), closeBtn),
        h('div', { class: `modal-body ${bodyClass}`.trim() }, body),
        footer ? h('div', { class: 'modal-foot' }, footer) : null);
    const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
    let closed = false;
    function close(result) {
        if (closed) return;
        closed = true;
        backdrop.remove();
        document.removeEventListener('keydown', onKey, true);
        openModals = Math.max(0, openModals - 1);
        if (!openModals) document.body.style.overflow = '';
        if (opener && opener.focus) opener.focus();
        if (onClose) onClose(result);
    }
    function onKey(e) {
        if (e.key === 'Escape' && backdrop === document.querySelector('.modal-backdrop:last-of-type')) { e.preventDefault(); close(); }
        if (e.key === 'Tab') {
            const focusables = [...dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }
    if (closeOnBackdrop) backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    openModals++;
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
        const target = dialog.querySelector('[autofocus], .modal-body input:not([type=hidden]):not([readonly]), .modal-body textarea, .modal-body select') || closeBtn;
        target.focus();
    }, 20);
    return { close, dialog, backdrop };
}

export function confirmDialog({ title = 'Emin misiniz?', message, confirmText = 'Onayla', danger = false, requireText = null }) {
    return new Promise(resolve => {
        let confirmBtn;
        const guard = requireText ? input({ placeholder: requireText, autocomplete: 'off', onInput: e => { confirmBtn.disabled = e.target.value.trim() !== requireText; } }) : null;
        const body = h('div', { class: 'form-stack' },
            h('p', { class: 'text-2', style: { whiteSpace: 'pre-line' } }, message),
            guard ? field(`Onaylamak için "${requireText}" yazın`, guard) : null);
        confirmBtn = btn(confirmText, { variant: danger ? 'danger-solid' : 'primary', disabled: !!requireText, onClick: () => modal.close(true) });
        const modal = openModal({
            title, body,
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close(false) }), confirmBtn],
            onClose: result => resolve(result === true)
        });
    });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmText = 'Tamam', type = 'text', help }) {
    return new Promise(resolve => {
        const control = type === 'textarea'
            ? h('textarea', { class: 'textarea', value, placeholder, rows: 5 })
            : input({ type, value, placeholder, autocomplete: 'off' });
        const form = h('form', { class: 'form-stack', onSubmit: e => { e.preventDefault(); modal.close(control.value); } }, field(label, control, { help }));
        const modal = openModal({
            title, body: form,
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close(null) }), btn(confirmText, { variant: 'primary', onClick: () => modal.close(control.value) })],
            onClose: result => resolve(typeof result === 'string' ? result : null)
        });
        setTimeout(() => { control.focus(); if (control.select) control.select(); }, 30);
    });
}

/**
 * Generic form modal. fields: [{ name, label, type, value, options, required, help, full, placeholder, min, max, step }]
 * `onSubmit(values)` may throw; the error is shown inline and the modal stays open.
 */
export function formDialog({ title, fields, submitText = 'Kaydet', onSubmit, size = '', intro }) {
    return new Promise(resolve => {
        const controls = {};
        const errorEl = h('div', { class: 'form-error', hidden: true });
        const grid = h('div', { class: 'form-grid' });
        fields.forEach(f => {
            let control;
            if (f.type === 'select') control = select(f.options || [], { name: f.name, value: f.value ?? '' });
            else if (f.type === 'textarea') control = h('textarea', { class: `textarea ${f.code ? 'code' : ''}`, name: f.name, value: f.value ?? '', rows: f.rows || 4, placeholder: f.placeholder || '' });
            else if (f.type === 'checkbox') control = h('label', { class: 'check' }, h('input', { type: 'checkbox', name: f.name, checked: !!f.value }), f.checkLabel || f.label);
            else control = input({ type: f.type || 'text', name: f.name, value: f.value ?? '', placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, required: f.required, autocomplete: 'off' });
            controls[f.name] = f.type === 'checkbox' ? control.querySelector('input') : control;
            const wrapper = field(f.type === 'checkbox' ? null : f.label, control, { help: f.help, id: `fd-${f.name}` });
            if (f.full || f.type === 'textarea') wrapper.classList.add('full');
            grid.appendChild(wrapper);
        });
        const submitBtn = btn(submitText, { variant: 'primary', type: 'submit' });
        const form = h('form', { class: 'form-stack', onSubmit: async e => {
            e.preventDefault();
            const values = {};
            for (const [name, control] of Object.entries(controls)) values[name] = control.type === 'checkbox' ? control.checked : control.value;
            errorEl.hidden = true;
            try {
                const result = onSubmit ? await withBusy(submitBtn, () => onSubmit(values)) : values;
                modal.close({ ok: true, result: result === undefined ? values : result });
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.hidden = false;
            }
        } }, intro ? h('p', { class: 'text-2' }, intro) : null, errorEl, grid);
        const modal = openModal({
            title, size,
            body: form,
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close(null) }), h('button', { class: 'btn btn-primary', type: 'button', onClick: () => form.requestSubmit() }, submitText)],
            onClose: result => resolve(result && result.ok ? result.result : null)
        });
    });
}

/** Attach a click-toggled dropdown menu to a trigger button. */
export function dropdown(trigger, buildMenu, { align = 'right', className = '' } = {}) {
    const wrapper = h('div', { class: 'dropdown' }, trigger);
    let menu = null;
    function closeMenu() {
        if (menu) { menu.remove(); menu = null; }
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', onKey, true);
    }
    function outside(e) { if (!wrapper.contains(e.target)) closeMenu(); }
    function onKey(e) { if (e.key === 'Escape') { closeMenu(); trigger.focus(); } }
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.addEventListener('click', e => {
        e.stopPropagation();
        if (menu) return closeMenu();
        menu = h('div', { class: `dropdown-menu ${className}`.trim(), role: 'menu', style: align === 'left' ? { left: '0', right: 'auto' } : {} });
        append(menu, [buildMenu(closeMenu)]);
        wrapper.appendChild(menu);
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', onKey, true);
    });
    return wrapper;
}

export function menuItem(label, onClick, { iconName, danger = false } = {}) {
    return h('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', onClick }, iconName ? icon(iconName, 'icon-sm') : null, label);
}

// ---------------------------------------------------------------------------
//  Formatting
// ---------------------------------------------------------------------------

export function currency() {
    return (state.summary && state.summary.settings && state.summary.settings.currency) || (state.config && state.config.currency) || 'TL';
}

export function fmtMoney(value) {
    const n = Number(value) || 0;
    return `${n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency()}`;
}

export function fmtNumber(value) {
    return (Number(value) || 0).toLocaleString('tr-TR');
}

export function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d) ? '—' : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d) ? '—' : d.toLocaleString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(value) {
    if (!value) return '—';
    const diff = (Date.now() - new Date(value).getTime()) / 1000;
    if (diff < 60) return 'az önce';
    if (diff < 3600) return `${Math.floor(diff / 60)} dk önce`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} sa önce`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} gün önce`;
    return fmtDate(value);
}

export function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function daysLeft(expiresAt) {
    return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
}

export function serverStatus(server) {
    if (server.suspended) return { key: 'suspended', label: server.suspended_reason === 'expired' ? 'Süresi doldu' : 'Askıda', variant: 'danger' };
    if (server.state === 'missing') return { key: 'offline', label: 'Konteyner yok', variant: 'danger' };
    if (server.state !== 'running') return { key: 'offline', label: 'Kapalı', variant: '' };
    if (!server.online) return { key: 'starting', label: 'Başlatılıyor', variant: 'warning' };
    return { key: 'online', label: 'Çevrimiçi', variant: 'success' };
}

export function statusBadge(server) {
    const s = serverStatus(server);
    return h('span', { class: `badge ${s.variant ? `badge-${s.variant}` : ''}` }, h('span', { class: `dot dot-${s.key}` }), s.label);
}

export function passwordScore(value) {
    let score = 0;
    if (value.length >= 8) score++;
    if (value.length >= 12) score++;
    if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score++;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score++;
    return value ? Math.max(1, Math.min(4, score)) : 0;
}

export function generatePassword(length = 14) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
}

// ---------------------------------------------------------------------------
//  Router
// ---------------------------------------------------------------------------

export function parseRoute(hash = window.location.hash) {
    const raw = hash.replace(/^#\/?/, '');
    const [pathPart, queryPart = ''] = raw.split('?');
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    return { parts, query: new URLSearchParams(queryPart), path: `/${parts.join('/')}` };
}

export function navigate(path) {
    const target = `#${path.startsWith('/') ? path : `/${path}`}`;
    if (window.location.hash === target) emit('route');
    else window.location.hash = target;
}
