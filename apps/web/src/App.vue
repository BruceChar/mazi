<script setup>
import { onMounted, ref } from 'vue';
import { api, API_BASE } from './api.js';

const sessions = ref([]);
const current = ref(null);
const detail = ref(null);
const query = ref('');
const input = ref('');
const userId = ref('');
const busy = ref(false);
const busyRun = ref(false);
const cfg = ref(null);
const tab = ref('audit');
const auditText = ref('选择 timeline 节点查看三方记录 / Usage');
const eventsText = ref('—');
const eventsCount = ref(0);
const errBox = ref(null);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s, n = 2000) => (s && s.length > n ? s.slice(0, n) + '…' : s);
const fmtUsd = (v) => '$' + Number(v ?? 0).toFixed(6);
const fmtTime = (t) => new Date(t).toLocaleString();
const icon = (k) => (k === 'thinking' ? '💭' : k === 'tool_call' ? '🔧' : k === 'observation' ? '📊' : '·');
function stepTitle(s) {
  const p = s.payload || {};
  if (s.kind === 'thinking') return short(p.content, 80);
  if (s.kind === 'tool_call') return p.toolName + ' ' + short(JSON.stringify(p.arguments || {}), 120);
  if (s.kind === 'observation') return short(p.content, 120);
  return s.stepId;
}
function toggleStep(e) { e.currentTarget.classList.toggle('open'); }


const dotClass = () => (cfg.value && cfg.value.providers.length ? 'ok' : 'bad') + (busy.value ? ' busy' : '');
const cfgText = () => {
  if (!cfg.value) return '…';
  const p = cfg.value;
  return (p.providers.length ? p.home + ' · ' + p.providers.join(', ') : p.home + ' · 未配置 provider') + ' · ' + p.storage.driver;
};

const filtered = () => sessions.value.filter((s) => {
  const q = query.value.trim().toLowerCase();
  return !q || String(s.title || s.input || '').toLowerCase().includes(q);
});

async function loadConfig() {
  try {
    cfg.value = await api('/api/config');
    if (!cfg.value.providers.length) errBox.value = '尚未配置 provider：请先运行 pnpm mazi config，再刷新。';
  } catch (e) {
    cfg.value = null;
    errBox.value = '无法连接后端 API：' + (API_BASE || 'http://127.0.0.1:4317') + '。请先启动后端：pnpm run server（或 pnpm api），勿用裸 pnpm server。';
  }
}
async function loadSessions() {
  try { sessions.value = await api('/api/sessions?limit=50'); } catch (e) { /* 静默 */ }
}
async function select(id) {
  current.value = id;
  await Promise.all([loadDetail(id), loadEvents(id)]);
}
async function loadDetail(id) {
  try {
    detail.value = await api('/api/sessions/' + id + '/timeline');
    metricsFrom(detail.value);
  } catch (e) { detail.value = null; errBox.value = String(e); }
}
const metrics = ref({ turns: 0, steps: 0, tokens: 0, cost: 0, model: '-' });
function metricsFrom(d) {
  let steps = 0, tokens = 0, cost = 0;
  (d.turns || []).forEach((t) => (t.steps || []).forEach((s) => {
    steps++;
    tokens += (s.usage && (s.usage.vendor.inputTokens + s.usage.vendor.outputTokens)) || 0;
    cost += (s.usage && s.usage.cost.totalCostUsd) || 0;
  }));
  metrics.value = { turns: (d.turns || []).length, steps, tokens, cost, model: (d.turns || []).map((t) => t.capacity && t.capacity.model && t.capacity.model.modelId).filter(Boolean)[0] || '-' };
}
async function loadEvents(id) {
  try {
    const ev = await api('/api/events/' + id + '?limit=5000');
    eventsCount.value = ev.length;
    eventsText.value = ev.map((e) => e.type + '  ' + [e.sessionId, e.turnId, e.stepId].filter(Boolean).join('/')).join(String.fromCharCode(10));
  } catch (e) { eventsText.value = String(e); }
}
async function postSession(exec) {
  const text = input.value.trim(); if (!text) return;
  busy.value = true;
  errBox.value = null;
  try {
    const body = JSON.stringify({ input: text, userId: userId.value || undefined });
    const created = await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await loadSessions();
    await select(created.sessionId);
    if (exec) {
      const result = await api('/api/sessions/' + created.sessionId + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await loadSessions();
      await select(result.sessionId);
    }
  } catch (e) { errBox.value = String(e); }
  finally { busy.value = false; }
}
async function runCurrent(id) {
  busy.value = true; errBox.value = null;
  try {
    const result = await api('/api/sessions/' + id + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await loadSessions();
    await select(result.sessionId);
  } catch (e) { errBox.value = String(e); }
  finally { busy.value = false; }
}
function showAudit(turn, step) {
  auditText.value = JSON.stringify({ turnStatus: turn.status, contract: turn.contract || {}, capacity: turn.capacity || null, step: { kind: step.kind, status: step.status, seq: step.seq, payload: step.payload, model: step.model, usage: step.usage } }, null, 2);
}
function outcomeBadge(o) { return o === 'success' ? 'success' : o ? 'failed' : 'other'; }
const canRun = (d) => d && d.outcome === undefined && d.state === 'running';
onMounted(async () => {
  await loadConfig();
  await loadSessions();
  if (sessions.value[0]) await select(sessions.value[0].sessionId);
});
</script>

<template>
  <header class="topbar">
    <span class="brand">mazi<em>·</em>harness</span>
    <span class="dim" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ cfgText() }}</span>
    <span class="status"><i class="dot" :class="dotClass()"></i>{{ busy ? 'running' : 'idle' }}<span id="apilog" class="dim"></span></span>
  </header>
  <main class="layout">
    <aside class="col">
      <div style="display:flex;gap:6px;padding:10px;border-bottom:1px solid var(--line)">
        <input v-model="query" placeholder="搜索会话…" />
      </div>
      <ul class="list">
        <li v-for="s in filtered()" :key="s.sessionId" :class="{ active: current === s.sessionId }" @click="select(s.sessionId)">
          <div class="mono" style="color:var(--fg)">{{ esc(s.title || s.input) }}</div>
          <div class="dim" style="font-size:11px;display:flex;gap:8px">
            <span class="badge" :class="outcomeBadge(s.outcome)">{{ s.outcome || 'running' }}</span>
            <span>{{ s.turns ?? '-' }} turns</span><span>{{ fmtUsd(s.costUsd) }}</span><span>{{ fmtTime(s.updatedAt) }}</span>
          </div>
        </li>
        <li v-if="!filtered().length" class="dim">暂无会话</li>
      </ul>
    </aside>
    <section class="col main">
      <div style="padding:12px 14px 6px">
        <textarea v-model="input" rows="3" placeholder="任务描述，例如：读取 README.md 并汇报" @keydown.ctrl.enter="postSession(true)"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input v-model="userId" placeholder="userId（可选）" />
          <button :disabled="busy" @click="postSession(false)">仅创建会话</button>
          <button class="primary" :disabled="busy" @click="postSession(true)">创建并运行</button>
        </div>
      </div>
      <div v-if="errBox" class="card" style="margin:8px 14px">{{ errBox }}</div>
      <div v-if="detail" style="padding:4px 14px 0;border-bottom:1px solid var(--line)">
        <div style="font-size:14px">{{ esc(detail.rawIntent) }}</div>
        <div class="dim" style="display:flex;gap:10px;font-size:11px;align-items:center">
          <span class="badge" :class="outcomeBadge(detail.outcome)">{{ detail.outcome || detail.state }}</span>
          <span>strategy {{ detail.strategyId }}</span>
          <button v-if="canRun(detail)" :disabled="busy" @click="runCurrent(detail.sessionId)">▶ 执行此会话</button>
        </div>
      </div>
      <div class="scroll" style="flex:1;padding:10px 14px;display:flex;flex-direction:column;gap:6px">
        <template v-if="detail && detail.turns && detail.turns.length">
          <template v-for="turn in detail.turns" :key="turn.turnId">
            <div class="card">Turn · {{ esc((turn.contract && turn.contract.statement) || turn.turnId) }} <span class="dim">status {{ turn.status }} · attempt {{ turn.attempt }}</span></div>
            <div v-for="s in turn.steps" :key="s.stepId" class="step" @click="toggleStep($event); showAudit(turn, s)">
              <div style="display:flex;gap:10px;align-items:center">
                <span>{{ icon(s.kind) }}</span><span>{{ esc(stepTitle(s)) }}</span>
                <span class="dim" style="font-size:11px">#{{ s.seq }} {{ s.status }}{{ s.model ? ' · ' + s.model.modelId : '' }}</span>
              </div>
              <pre>{{ JSON.stringify({ payload: s.payload, usage: s.usage }, null, 2) }}</pre>
            </div>
          </template>
        </template>
        <div v-else-if="detail" class="dim">（空会话：创建后点击“▶ 执行此会话”）</div>
      </div>
    </section>
    <aside class="col">
      <div style="display:flex;border-bottom:1px solid var(--line)">
        <button style="flex:1;border:0;background:transparent" :class="tab === 'audit' ? 'active':''" @click="tab = 'audit'">审计</button>
        <button style="flex:1;border:0;background:transparent" @click="tab = 'events'">事件</button>
      </div>
      <div v-show="tab === 'audit'" class="scroll" style="flex:1;padding:10px"><pre class="mono">{{ auditText }}</pre></div>
      <div v-show="tab === 'events'" class="scroll" style="flex:1;padding:10px"><pre class="mono">{{ eventsText }}</pre><div class="dim" style="margin-top:4px">{{ eventsCount }} events</div></div>
    </aside>
  </main>
  <footer class="bottom">
    <span>turns <b>{{ metrics.turns }}</b></span><span>steps <b>{{ metrics.steps }}</b></span>
    <span>tokens <b>{{ metrics.tokens }}</b></span><span>cost <b>{{ fmtUsd(metrics.cost) }}</b></span><span class="dim">model {{ metrics.model }}</span>
  </footer>
</template>