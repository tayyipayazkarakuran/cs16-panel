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
        if (res.status === 402 && error.code === 'SERVER_SUSPENDED') emit('paywall', error);
        if (res.status === 402 && error.code === 'INSUFFICIENT_BALANCE') emit('insufficient-balance', error);
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
    arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
    arrowRight: 'M5 12h14M12 5l7 7-7 7',
    calendar: 'M4 5h16v16H4zM16 3v4M8 3v4M4 11h16',
    chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    hardDrive: 'M22 12H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1zM6 16h.01M10 16h.01',
    memory: 'M6 19v2M10 19v2M14 19v2M18 19v2M3 7h18v12H3zM7 11h2v4H7zM15 11h2v4h-2z',
    network: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01',
    filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
    pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
    rocket: 'M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1zM12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2zM9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5',
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

export function btn(label, { variant = '', size = '', iconName = null, onClick, type = 'button', title, disabled, block = false, className = '', attrs = {} } = {}) {
    const classes = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, !label && 'btn-icon', block && 'btn-block', className].filter(Boolean).join(' ');
    return h('button', { class: classes, type, onClick, title: title || null, 'aria-label': !label ? title : null, disabled, ...attrs },
        iconName ? icon(iconName, size ? 'icon-sm' : '') : null, label ? h('span', {}, label) : null);
}

/** An <a> styled like a button (navigation, downloads). */
export function linkBtn(label, href, { variant = '', size = '', iconName = null, title, block = false, attrs = {} } = {}) {
    const classes = ['btn', variant && `btn-${variant}`, size && `btn-${size}`, !label && 'btn-icon', block && 'btn-block'].filter(Boolean).join(' ');
    return h('a', { class: classes, href, title: title || null, 'aria-label': !label ? title : null, ...attrs },
        iconName ? icon(iconName, size ? 'icon-sm' : '') : null, label ? h('span', {}, label) : null);
}

export function debounce(fn, wait = 250) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
}

/** Search box with a leading icon; `onSearch` is debounced. */
export function searchInput({ placeholder = 'Ara…', value = '', onSearch, wait = 200, label } = {}) {
    const control = input({ type: 'search', placeholder, value, 'aria-label': label || placeholder, autocomplete: 'off' });
    if (onSearch) control.addEventListener('input', debounce(() => onSearch(control.value.trim()), wait));
    const wrap = h('div', { class: 'search-input' }, icon('search', 'icon-sm'), control);
    wrap.control = control;
    return wrap;
}

/** "1-50 / 230" + previous/next buttons. */
export function pager({ offset = 0, limit = 50, count = 0, total = null, onChange }) {
    const from = count ? offset + 1 : 0;
    const to = offset + count;
    const hasMore = total !== null ? to < total : count >= limit;
    return h('div', { class: 'table-foot' },
        h('span', {}, total !== null ? `${from}–${to} / ${total}` : (count ? `${from}–${to}` : '0 kayıt')),
        h('div', { class: 'pager' },
            btn('Önceki', { size: 'sm', iconName: 'arrowLeft', disabled: offset <= 0, onClick: () => onChange(Math.max(0, offset - limit)) }),
            btn('Sonraki', { size: 'sm', iconName: 'arrowRight', disabled: !hasMore, onClick: () => onChange(offset + limit) })));
}

/** Download a protected file with fetch so errors surface as toasts instead of saved JSON. */
export async function downloadFile(url, fallbackName = 'download') {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        let message = `İndirme başarısız (HTTP ${res.status}).`;
        try { const data = await res.json(); if (data.error) message = data.error; } catch (_) { /* not json */ }
        if (res.status === 401) emit('session-expired');
        throw new ApiError(message, { status: res.status });
    }
    const disposition = res.headers.get('content-disposition') || '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    const name = match ? decodeURIComponent(match[1]) : fallbackName;
    saveBlob(await res.blob(), name);
}

export function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, hidden: true });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** rows: array of objects; columns: [{ key, label, value?(row) }] */
export function downloadCsv(filename, columns, rows) {
    const esc = v => {
        const s = v === null || v === undefined ? '' : String(v);
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formulas
        return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [columns.map(c => esc(c.label)).join(';')];
    rows.forEach(r => lines.push(columns.map(c => esc(c.value ? c.value(r) : r[c.key])).join(';')));
    saveBlob(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), filename);
}

export const validators = {
    steamId: v => /^STEAM_[0-5]:[01]:\d{1,12}$/i.test(v),
    ip: v => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v),
    domain: v => /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(v),
    slug: v => /^[a-z0-9][a-z0-9_-]{1,31}$/.test(v)
};

/** Run an async action while showing a spinner on the button. */
export async function withBusy(button, fn) {
    const wasDisabled = button ? button.disabled : false;
    if (button) { button.classList.add('is-loading'); button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
        return await fn();
    } finally {
        if (button) { button.classList.remove('is-loading'); button.disabled = wasDisabled; button.removeAttribute('aria-busy'); }
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

const COLUMN_TYPE_CLASS = { num: 'num', money: 'num', date: 'date', actions: 'actions', mono: 'mono', check: 'check-col', wrap: 'wrap' };

function isEmptyCell(value) {
    return value === null || value === undefined || value === '' || value === false;
}

/**
 * columns: [{ key, label, render?(row,i), type?: 'num'|'money'|'date'|'actions'|'mono'|'check'|'wrap',
 *             class?, hideSm?, sort?: (row) => comparable }]
 * options: { empty, rowAttrs(row,i), onRowClick(row), scrollY, initialSort: { key, dir } }
 */
export function table(columns, rows, { empty = 'Kayıt bulunamadı.', rowAttrs, onRowClick, scrollY = false, initialSort = null } = {}) {
    const classFor = c => [COLUMN_TYPE_CLASS[c.type], c.class, c.hideSm && 'hide-sm'].filter(Boolean).join(' ');
    let sortState = initialSort ? { ...initialSort } : null;
    const tbody = h('tbody');
    const headRow = h('tr');

    function sortedRows() {
        if (!sortState) return rows;
        const col = columns.find(c => (c.key || c.label) === sortState.key);
        if (!col || !col.sort) return rows;
        const dir = sortState.dir === 'desc' ? -1 : 1;
        return [...rows].sort((a, b) => {
            const va = col.sort(a);
            const vb = col.sort(b);
            if (va === vb) return 0;
            if (va === null || va === undefined) return 1;
            if (vb === null || vb === undefined) return -1;
            return (typeof va === 'string' ? va.localeCompare(vb, 'tr') : va - vb) * dir;
        });
    }

    function paintHead() {
        clear(headRow, columns.map(c => {
            const id = c.key || c.label;
            if (!c.sort) return h('th', { class: classFor(c), scope: 'col' }, c.label || '');
            const active = sortState && sortState.key === id;
            return h('th', { class: classFor(c), scope: 'col', 'aria-sort': active ? (sortState.dir === 'desc' ? 'descending' : 'ascending') : null },
                h('button', { type: 'button', class: `sort-btn ${active ? 'active' : ''}`, onClick: () => {
                    sortState = { key: id, dir: active && sortState.dir === 'asc' ? 'desc' : 'asc' };
                    paintHead();
                    paintBody();
                } }, c.label, active ? icon(sortState.dir === 'desc' ? 'arrowDown' : 'arrowUp', 'icon-sm') : null));
        }));
    }

    function paintBody() {
        clear(tbody);
        if (!rows.length) {
            tbody.appendChild(h('tr', {}, h('td', { colspan: columns.length, class: 'table-empty' }, empty)));
            return;
        }
        sortedRows().forEach((row, i) => {
            const extra = rowAttrs ? rowAttrs(row, i) || {} : {};
            const tr = h('tr', extra);
            if (onRowClick) {
                tr.classList.add('clickable');
                tr.tabIndex = 0;
                tr.addEventListener('click', e => { if (!e.target.closest('button, a, input, select, label, .dropdown')) onRowClick(row, e); });
                tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) onRowClick(row, e); });
            }
            columns.forEach(c => {
                const value = c.render ? c.render(row, i) : row[c.key];
                tr.appendChild(h('td', { class: classFor(c) }, isEmptyCell(value) && c.type !== 'actions' && c.type !== 'check' ? h('span', { class: 'muted' }, '—') : value));
            });
            tbody.appendChild(tr);
        });
    }

    paintHead();
    paintBody();
    return h('div', { class: `table-wrap ${scrollY ? 'scroll-y' : ''}`.trim() }, h('table', { class: 'table' }, h('thead', {}, headRow), tbody));
}

/** Right-aligned row of compact action buttons for a table "actions" column. */
export function tableActions(...items) {
    return h('div', { class: 'table-actions' }, items);
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
/** toast(message, type, duration, { action: { label, onClick } }) */
export function toast(message, type = 'info', duration = 4500, { action = null } = {}) {
    if (!toastRoot) {
        toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(toastRoot);
    }
    const icons = { success: 'check', error: 'alert', warning: 'alert', info: 'info' };
    const el = h('div', { class: `toast toast-${type}` }, icon(icons[type] || 'info'),
        h('div', { class: 'msg' }, message,
            action ? h('div', { class: 'toast-action' }, btn(action.label, { size: 'xs', variant: 'primary', onClick: () => { el.remove(); action.onClick(); } })) : null),
        h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Kapat', onClick: () => el.remove() }, icon('x', 'icon-sm')));
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
        if (!openModals) document.body.classList.remove('scroll-locked');
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
    document.body.classList.add('scroll-locked');
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
            h('p', { class: 'text-2 pre-line' }, message),
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
 * Generic form modal.
 * fields: [{ name, label, type, value, options, required, help, full, placeholder, min, max, step,
 *            pattern, maxlength, code, rows, checkLabel, showIf?(values), validate?(value, values) => message|null }]
 * type 'chips': multi-select toggle chips — options [{ value, label }], value = array.
 * `onSubmit(values)` may throw; the error is shown inline and the modal stays open.
 */
export function formDialog({ title, fields, submitText = 'Kaydet', onSubmit, size = '', intro, danger = false }) {
    return new Promise(resolve => {
        const controls = {};
        const wrappers = {};
        const errorEl = h('div', { class: 'form-error', role: 'alert', hidden: true });
        const grid = h('div', { class: 'form-grid' });

        const readValues = () => {
            const values = {};
            for (const [name, control] of Object.entries(controls)) {
                if (control.chipValues) values[name] = [...control.chipValues];
                else values[name] = control.type === 'checkbox' ? control.checked : control.value;
            }
            return values;
        };
        const refreshVisibility = () => {
            const values = readValues();
            fields.forEach(f => { if (f.showIf) wrappers[f.name].hidden = !f.showIf(values); });
        };

        fields.forEach(f => {
            if (f.type === 'custom') {
                // Read-only content (e.g. a breakdown table); not part of the submitted values.
                const wrapper = h('div', { class: 'field full' }, f.render());
                wrappers[f.name] = wrapper;
                grid.appendChild(wrapper);
                return;
            }
            let control;
            if (f.type === 'select') control = select(f.options || [], { name: f.name, value: f.value ?? '' });
            else if (f.type === 'textarea') control = h('textarea', { class: `textarea ${f.code ? 'code' : ''}`, name: f.name, value: f.value ?? '', rows: f.rows || 4, placeholder: f.placeholder || '', maxlength: f.maxlength });
            else if (f.type === 'checkbox') control = h('label', { class: 'check' }, h('input', { type: 'checkbox', name: f.name, checked: !!f.value }), f.checkLabel || f.label);
            else if (f.type === 'chips') {
                const chosen = new Set((f.value || []).map(String));
                control = h('div', { class: 'chips', role: 'group', 'aria-label': f.label });
                control.chipValues = chosen;
                (f.options || []).forEach(o => {
                    const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': chosen.has(String(o.value)) ? 'true' : 'false', onClick: () => {
                        const v = String(o.value);
                        if (chosen.has(v)) chosen.delete(v); else chosen.add(v);
                        chip.setAttribute('aria-pressed', chosen.has(v) ? 'true' : 'false');
                        refreshVisibility();
                    } }, o.label);
                    control.appendChild(chip);
                });
            } else control = input({ type: f.type || 'text', name: f.name, value: f.value ?? '', placeholder: f.placeholder || '', min: f.min, max: f.max, step: f.step, required: f.required, pattern: f.pattern, maxlength: f.maxlength, autocomplete: 'off', class: f.code ? 'code' : '' });
            controls[f.name] = f.type === 'checkbox' ? control.querySelector('input') : control;
            const wrapper = field(f.type === 'checkbox' ? null : f.label, control, { help: f.help, id: f.type === 'chips' ? null : `fd-${f.name}` });
            if (f.full || f.type === 'textarea' || f.type === 'chips') wrapper.classList.add('full');
            wrappers[f.name] = wrapper;
            grid.appendChild(wrapper);
            if (f.type !== 'chips') controls[f.name].addEventListener(f.type === 'select' || f.type === 'checkbox' ? 'change' : 'input', () => {
                wrapper.classList.remove('invalid');
                const err = wrapper.querySelector('.field-error');
                if (err) err.remove();
                refreshVisibility();
            });
        });
        refreshVisibility();

        const submitBtn = btn(submitText, { variant: danger ? 'danger-solid' : 'primary', onClick: () => form.requestSubmit() });
        const form = h('form', { class: 'form-stack', novalidate: true, onSubmit: async e => {
            e.preventDefault();
            const values = readValues();
            errorEl.hidden = true;
            let firstInvalid = null;
            fields.forEach(f => {
                if (f.type === 'custom') return;
                const wrapper = wrappers[f.name];
                wrapper.classList.remove('invalid');
                const old = wrapper.querySelector('.field-error');
                if (old) old.remove();
                if (wrapper.hidden) return;
                const value = values[f.name];
                let message = null;
                if (f.required && (value === '' || value === null || (Array.isArray(value) && !value.length))) message = 'Bu alan zorunlu.';
                else if (f.validate && value !== '' && value !== null) message = f.validate(value, values) || null;
                else if (controls[f.name].validity && !controls[f.name].validity.valid) message = controls[f.name].validationMessage;
                if (message) {
                    wrapper.classList.add('invalid');
                    wrapper.appendChild(h('div', { class: 'field-error' }, message));
                    if (!firstInvalid) firstInvalid = controls[f.name];
                }
            });
            if (firstInvalid) { if (firstInvalid.focus) firstInvalid.focus(); return; }
            try {
                const result = onSubmit ? await withBusy(submitBtn, () => onSubmit(values)) : values;
                modal.close({ ok: true, result: result === undefined ? values : result });
            } catch (error) {
                errorEl.textContent = error.message;
                errorEl.hidden = false;
            }
        } }, intro ? h('p', { class: 'text-2' }, intro) : null, errorEl, grid,
        // Hidden submit so Enter inside an input submits the form.
        h('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' }));
        const modal = openModal({
            title, size,
            body: form,
            footer: [btn('Vazgeç', { variant: 'ghost', onClick: () => modal.close(null) }), submitBtn],
            onClose: result => resolve(result && result.ok ? result.result : null)
        });
    });
}

/**
 * Click-toggled dropdown menu. The menu is rendered in a fixed layer on
 * <body> so table wrappers (overflow: auto) never clip it, and it flips
 * above the trigger / to the other side when it would leave the viewport.
 */
let closeOpenDropdown = null;
export function dropdown(trigger, buildMenu, { align = 'right', className = '' } = {}) {
    const wrapper = h('div', { class: 'dropdown' }, trigger);
    let menu = null;

    function position() {
        if (!menu) return;
        const r = trigger.getBoundingClientRect();
        const m = menu.getBoundingClientRect();
        const vw = document.documentElement.clientWidth;
        const vh = window.innerHeight;
        const gap = 6;
        let left = align === 'left' ? r.left : r.right - m.width;
        left = Math.max(8, Math.min(left, vw - m.width - 8));
        let top = r.bottom + gap;
        if (top + m.height > vh - 8 && r.top - gap - m.height > 8) top = r.top - gap - m.height;
        top = Math.max(8, Math.min(top, vh - m.height - 8));
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }
    function items() { return menu ? [...menu.querySelectorAll('[role=menuitem]:not(:disabled)')] : []; }
    function closeMenu({ focusTrigger = false } = {}) {
        if (menu) { menu.remove(); menu = null; }
        trigger.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('scroll', onViewportChange, true);
        if (closeOpenDropdown === closeMenu) closeOpenDropdown = null;
        if (focusTrigger) trigger.focus();
    }
    function outside(e) { if (!wrapper.contains(e.target) && !(menu && menu.contains(e.target))) closeMenu(); }
    function onViewportChange(e) {
        if (!menu) return;
        if (e && e.type === 'scroll') {
            if (menu.contains(e.target)) return;
            // Follow the trigger while the page scrolls; close once it leaves the screen.
            const r = trigger.getBoundingClientRect();
            if (r.bottom < 0 || r.top > window.innerHeight) closeMenu();
            else position();
            return;
        }
        closeMenu();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); closeMenu({ focusTrigger: true }); return; }
        if (e.key === 'Tab') { closeMenu(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const list = items();
            if (!list.length) return;
            e.preventDefault();
            const index = list.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? (index + 1) % list.length : (index <= 0 ? list.length - 1 : index - 1);
            list[next].focus();
        }
    }
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', e => {
        e.stopPropagation();
        if (menu) return closeMenu();
        if (closeOpenDropdown) closeOpenDropdown();
        menu = h('div', { class: `dropdown-menu ${className}`.trim(), role: 'menu' });
        append(menu, [buildMenu(closeMenu)]);
        menu.style.visibility = 'hidden';
        document.body.appendChild(menu);
        position();
        menu.style.visibility = '';
        trigger.setAttribute('aria-expanded', 'true');
        closeOpenDropdown = closeMenu;
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('scroll', onViewportChange, true);
        if (e.detail === 0) { const first = items()[0]; if (first) first.focus(); } // keyboard open
    });
    wrapper.reposition = position;
    return wrapper;
}

export function menuItem(label, onClick, { iconName, danger = false, disabled = false } = {}) {
    return h('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', onClick, disabled }, iconName ? icon(iconName, 'icon-sm') : null, h('span', {}, label));
}

export function menuSep() {
    return h('div', { class: 'sep', role: 'separator' });
}

/** "⋯" button opening a menu of actions; for table rows and card heads. */
export function moreMenu(buildItems, { title = 'Diğer işlemler', size = 'xs' } = {}) {
    return dropdown(btn(null, { size, variant: 'ghost', iconName: 'more', title }), close => buildItems(close));
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
