/* mazi WebUI MVP（webui.md 三栏）：会话列表 / 轨迹对话 / 审计+事件 / 底部指标 */
const API_BASE = (() => {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q.replace(/\/$/, '');
  return location.port === '5174' || location.port === '4173' ? 'http://127.0.0.1:4317' : '';
})();
const $ = (id) => document.getElementById(id);
const state = { sessions: [], current: null, detail: null };

const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s, n = 2000) => (s && s.length > n ? s.slice(0, n) + '…' : s);
const icon = (k) => (k === 'thinking' ? '💭' : k === 'tool_call' ? '🔧' : k === 'observation' ? '📊' : '·');
const fmtTime = (t) => new Date(t).toLocaleString();
const fmtUsd = (v) => '$' + Number(v ?? 0).toFixed(6);

async function api(path, init) {
    const res = await fetch(API_BASE + path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

function setDot(ok, busy) {
    $('dot').className = 'dot' + (ok ? ' ok' : '') + (busy ? ' busy' : '');
}

async function loadConfig() {
    try {
        const cfg = await api('/api/config');
        const ok = cfg.providers.length > 0;
        setDot(ok, false);
        $('cfgline').textContent = (ok ? cfg.home + ' · ' + cfg.providers.join(', ') : cfg.home + ' · 未配置 provider') + ' · ' + cfg.storage.driver;
        if (!ok) {
            $('timeline').innerHTML = '<div class="result-card"><div class="sh-title">尚未配置 provider</div><div class="sh-meta">请先运行 pnpm mazi config（写入 ~/.mazi），再刷新。</div></div>';
        }
        return cfg;
    } catch (e) {
        setDot(false, false);
        $('cfgline').textContent = '后端未连接 ' + (API_BASE || 'http://127.0.0.1:4317');
        $('timeline').innerHTML =
            '<div class="result-card"><div class="sh-title">无法连接后端 API</div>' +
            '<div class="sh-meta">请先启动后端：pnpm run server（或 pnpm api）——注意不要用裸 pnpm server（那是 pnpm 内建 store 命令）。<br>' +
            '后端地址：' + esc(API_BASE || 'http://127.0.0.1:4317') + '　<button data-retry>重试</button></div></div>';
    }
}

async function loadSessions() {
    try {
        const list = await api('/api/sessions?limit=50');
        state.sessions = list;
        renderSessions();
    } catch (e) {
        // 静默：首页无记录正常
    }
}

function renderSessions() {
    const q = ($('sess-search').value || '').trim().toLowerCase();
    const ul = $('session-list');
    const rows = state.sessions.filter((s) => !q || String(s.title || s.input).toLowerCase().includes(q));
    ul.innerHTML = rows.length
        ? rows
              .map(
                  (s) =>
                      '<li data-id="' + s.sessionId + '" class="' + (state.current === s.sessionId ? 'active' : '') + '">' +
                      '<div class="li-title">' + esc(s.title || s.input) + '</div>' +
                      '<div class="li-meta"><span class="badge ' + (s.outcome === 'success' ? 'success' : s.outcome ? 'failed' : 'other') + '">' + esc(s.outcome || 'running') + '</span>' +
                      '<span>' + (s.turns ?? '-') + ' turns</span><span>' + fmtUsd(s.costUsd) + '</span><span>' + fmtTime(s.updatedAt) + '</span></div></li>',
              )
              .join('')
        : '<li class="dim">暂无会话</li>';
}

async function selectSession(id) {
    state.current = id;
    renderSessions();
    await Promise.all([loadTimeline(id), loadEvents(id)]);
}

async function loadTimeline(id) {
    try {
        const detail = await api('/api/sessions/' + id + '/timeline');
        state.detail = detail;
        const goal = detail.goal || {};
        const canRun = detail.outcome === undefined && detail.state === 'running';
        $('session-head').innerHTML =
            '<div class="sh-title">' + esc(detail.rawIntent || goal.statement || '') + '</div>' +
            '<div class="sh-meta"><span class="badge ' + (detail.outcome === 'success' ? 'success' : detail.outcome ? 'failed' : 'other') + '">' + esc(detail.outcome || detail.state) + '</span>' +
            '<span>strategy ' + esc(detail.strategyId) + '</span><span>model ' + esc(detail.turns.map((t) => t.capacity && t.capacity.model && t.capacity.model.modelId).filter(Boolean)[0] || '-') + '</span>' +
            (canRun ? ' <button data-run="' + id + '" class="ghost">▶ 执行此会话</button>' : '') + '</div>';
        renderTimeline(detail.turns);
        updateMetrics(detail);
    } catch (e) {
        $('session-head').innerHTML = '<div class="sh-meta">' + esc(String(e)) + '</div>';
    }
}

function renderTimeline(turns) {
    const box = $('timeline');
    box.innerHTML = '';
    if (!turns || turns.length === 0) {
        box.innerHTML = '<div class="dim">（无轨迹）</div>';
        return;
    }
    turns.forEach((turn) => {
        const head = document.createElement('div');
        head.className = 'result-card';
        head.innerHTML =
            '<div class="sh-title">Turn · ' + esc((turn.contract && turn.contract.statement) || turn.turnId) + '</div>' +
            '<div class="sh-meta"><span>status ' + esc(turn.status) + '</span><span>attempt ' + turn.attempt + '</span>' +
            (turn.capacity ? '<span>perm ' + esc(turn.capacity.permission) + '</span>' : '') + '</div>';
        box.appendChild(head);
        (turn.steps || []).forEach((s) => {
            const row = document.createElement('div');
            row.className = 'step';
            row.dataset.turn = turn.turnId;
            row.dataset.step = s.stepId;
            const payload = s.payload || {};
            const title =
                s.kind === 'thinking' ? short(payload.content, 80) :
                s.kind === 'tool_call' ? payload.toolName + ' ' + short(JSON.stringify(payload.arguments || {}), 120) :
                s.kind === 'observation' ? short(payload.content, 120) : s.stepId;
            row.innerHTML =
                '<div class="s-top"><span class="icon-' + (s.kind === 'thinking' ? 'think' : s.kind === 'tool_call' ? 'tool' : 'obs') + '">' + icon(s.kind) + '</span>' +
                '<span class="s-title">' + esc(title) + '</span>' +
                '<span class="s-meta">#' + s.seq + ' ' + esc(s.status) + (s.model ? ' · ' + esc(s.model.modelId) : '') + '</span></div>' +
                '<pre>' + esc(JSON.stringify({ payload, usage: s.usage }, null, 2)) + '</pre>';
            row.addEventListener('click', () => {
                row.classList.toggle('open');
                renderAudit(turn, s);
            });
            box.appendChild(row);
        });
    });
}

function renderAudit(turn, step) {
    const view = {
        turnStatus: turn.status,
        contract: turn.contract || {},
        capacity: turn.capacity || null,
        step: { kind: step.kind, status: step.status, seq: step.seq, payload: step.payload, model: step.model, usage: step.usage },
    };
    $('audit').textContent = JSON.stringify(view, null, 2);
}

async function loadEvents(id) {
    try {
        const events = await api('/api/events/' + id + '?limit=5000');
        $('evcount').textContent = events.length + ' events';
        $('events').textContent = events.map((e) => e.type + '  ' + [e.sessionId, e.turnId, e.stepId].filter(Boolean).join('/')).join('
');
    } catch (e) {
        $('events').textContent = String(e);
    }
}

function updateMetrics(detail) {
    let steps = 0;
    let tokens = 0;
    let cost = 0;
    (detail.turns || []).forEach((t) => (t.steps || []).forEach((s) => {
        steps++;
        tokens += (s.usage && (s.usage.vendor.inputTokens + s.usage.vendor.outputTokens)) || 0;
        cost += (s.usage && s.usage.cost.totalCostUsd) || 0;
    }));
    $('m-turns').textContent = detail.turns ? detail.turns.length : 0;
    $('m-steps').textContent = steps;
    $('m-tokens').textContent = tokens;
    $('m-cost').textContent = fmtUsd(cost);
    const model = (detail.turns || []).map((t) => t.capacity && t.capacity.model && t.capacity.model.modelId).filter(Boolean)[0];
    $('m-driver').textContent = 'model ' + (model || '-');
}

async function postSession(exec) {
    const input = $('input').value.trim();
    if (!input) return;
    const btn = exec ? $('run') : $('create');
    btn.disabled = true;
    btn.textContent = exec ? '运行中…' : '创建中…';
    try {
        // 先真实创建会话（写库 + recording 记录）
        const created = await api('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input, userId: $('user').value || undefined }),
        });
        await loadSessions();
        await selectSession(created.sessionId);
        if (exec) {
            const result = await api('/api/sessions/' + created.sessionId + '/run', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            });
            await loadSessions();
            await selectSession(result.sessionId);
        }
    } catch (e) {
        const box = $('timeline');
        box.innerHTML = '<div class="result-card"><div class="sh-title">失败</div><div class="sh-meta">' + esc(String(e)) + '</div></div>';
    } finally {
        btn.disabled = false;
        btn.textContent = exec ? '创建并运行' : '仅创建会话';
    }
}

async function run() {
    return postSession(true);
}
async function createOnly() {
    return postSession(false);
}

// tabs
document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        $('tab-audit').classList.toggle('hidden', t.dataset.tab !== 'audit');
        $('tab-events').classList.toggle('hidden', t.dataset.tab !== 'events');
    }),
);

document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-retry]')) {
        setDot(false, true);
        $('cfgline').textContent = '重试中…';
        loadConfig();
        return;
    }
});
document.addEventListener('click', async (e) => {
    const btn = e.target.closest ? e.target.closest('[data-run]') : null;
    if (!btn) return;
    const sid = btn.getAttribute('data-run');
    btn.disabled = true;
    try {
        const result = await api('/api/sessions/' + sid + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await loadSessions();
        await selectSession(result.sessionId);
    } catch (err) {
        $('timeline').innerHTML = '<div class="result-card"><div class="sh-title">执行失败</div><div class="sh-meta">' + esc(String(err)) + '</div></div>';
    }
});

document.addEventListener('DOMContentLoaded', async () => {
    $('run').addEventListener('click', run);
    $('create').addEventListener('click', createOnly);
    $('input').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
    $('new-session').addEventListener('click', () => { $('input').focus(); });
    $('sess-search').addEventListener('input', renderSessions);
    $('session-list').addEventListener('click', (e) => {
        const li = e.target.closest('[data-id]');
        if (li) selectSession(li.dataset.id);
    });
    const cfg = await loadConfig();
    if (cfg && cfg.providers.length === 0) {
        $('timeline').innerHTML = '<div class="result-card"><div class="sh-title">尚未配置 provider</div><div class="sh-meta">请运行 pnpm mazi config，然后刷新本页。</div></div>';
    }
    await loadSessions();
    if (state.sessions[0]) await selectSession(state.sessions[0].sessionId);
});