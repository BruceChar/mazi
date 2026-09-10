const query = new URLSearchParams(location.search);

export const API_BASE = (query.get('api') || '').replace(/\/$/, '');

/** Shared REST helper: rejects with Error and mirrors status into the top-bar log line. */
export async function api(path: string, init?: RequestInit) {
    const started = Date.now();
    const full = API_BASE + path;
    const label = `${init && init.method ? init.method : 'GET'} ${full}`;
    let res;
    try {
        res = await fetch(full, init);
    } catch (error) {
        logApi(`${label} -> ERR ${String(error)}`);
        throw new Error('无法连接后端：请启动 pnpm run server / pnpm api');
    }
    const data = await res.json().catch(() => ({}));
    const ms = Date.now() - started;
    logApi(`${label} -> ${res.status} (${ms}ms)`);
    if (!res.ok) {
        throw new Error(data.error || `${res.status} ${res.statusText}`);
    }
    return data;
}

export function logApi(text: string) {
    const el = document.getElementById('apilog');
    if (el) {
        el.textContent = text;
    }
}
