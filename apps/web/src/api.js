const query = new URLSearchParams(location.search);

export const API_BASE = (
    query.get('api') || (location.port === '5174' ? 'http://127.0.0.1:4317' : '')
).replace(/\/$/, '');

/** 统一 REST 请求：错误统一抛 Error，API 状态写到顶栏小字（后端不可用时无 UI 崩溃） */
export async function api(path, init) {
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

export function logApi(text) {
    const el = document.getElementById('apilog');
    if (el) {
        el.textContent = text;
    }
}
