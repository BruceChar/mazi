<script setup>
import { computed, onMounted, ref } from 'vue';
import { API_BASE } from './api.js';
import { api } from './api.js';
import { loadConfig, loadSessions, select, createAndRun, runCurrent, sendFeedback, loadProfile, ui, sessions, current, detail, cfg, busy, metrics, events, fmtUsd, fmtTime, esc, short, icon, badge } from './store.js';
const showNew = ref(false);
const q = ref('');
const trajFilter = ref('all');
const view = ref('chat');
const mainTab = ref('chat');
const rightTab = ref('audit');
const auditView = ref('actual');
const draft = ref({ statement: '', permission: 'read-only', budgetUsd: 0.5, maxSteps: 8 });
const profile = ref(null);
const ledger = ref(null);
const stepOpen = ref({});
const openFeedback = ref(false);
const feedbackSent = ref(false);
const cfgText = computed(() => { const c = cfg.value; if (!c) return '…'; return c.home + ' · ' + (c.providers.length ? c.providers.join(', ') : '未配置 provider') + ' · ' + c.storage.driver; });
const budgetPct = computed(() => { const b = metrics.budget; if (!b) return null; return Math.min(100, Math.round((metrics.cost / b) * 100)); });
const filteredEvents = computed(() => events.list.filter((e) => events.types === 'all' || e.type.startsWith(events.types)).map((e) => e));
const isCanRun = computed(() => detail.value && detail.value.outcome === undefined && detail.value.state === 'running');
async function openNew() { showNew.value = true; }
async function submitDraft(exec) { await createAndRun(exec, { statement: draft.value.statement || null, permissionCeiling: draft.value.permission, maxCostUsd: Number(draft.value.budgetUsd) || undefined, maxSteps: Number(draft.value.maxSteps) || undefined }); if (exec) showNew.value = false; }
function stepTitle(s) { const p = s.payload || {}; if (s.kind === 'thinking') return short(p.content, 90); if (s.kind === 'tool_call') return p.toolName + ' ' + short(JSON.stringify(p.arguments || {}), 100); if (s.kind === 'observation') return short(p.content, 120); return s.stepId; }
function toggleStep(id) { stepOpen.value[id] = !stepOpen.value[id]; }
function showAudit(turn, step) { ui.audit = { turn, step }; rightTab.value = 'audit'; }
function triple() { const a = ui.audit; if (!a || !a.step) return ''; const obj = { sessionId: a.step.sessionId, turnId: a.step.turnId, stepId: a.step.stepId, seq: a.step.seq, kind: a.step.kind, status: a.step.status, payload: a.step.payload, model: a.step.model, usage: a.step.usage, contract: (a.turn && a.turn.contract) || null, capacity: (a.turn && a.turn.capacity) || null }; return JSON.stringify(obj, null, 2); }
function usageSegs() { const s = ui.audit && ui.audit.step && ui.audit.step.usage; if (!s) return []; const r = s.runtime; const segs = [ { k: 'sys', v: r && r.systemPromptTokens, c: '#60a5fa' }, { k: 'hist', v: r && r.historyTokens, c: '#a78bfa' }, { k: 'tool', v: r && r.toolSchemaTokens, c: '#34d399' }, { k: 'in', v: r && r.newInputTokens, c: '#fbbf24' }, { k: 'obs', v: r && r.observationTokens, c: '#f472b6' } ].filter((x) => x.v > 0); const tot = segs.reduce((a, b) => a + b.v, 0) || 1; return segs.map((x) => ({ ...x, w: Math.max(2, Math.round((x.v / tot) * 100)) })); }
function vendorStats() { const s = ui.audit && ui.audit.step && ui.audit.step.usage; if (!s) return null; const v = s.vendor || {}; const t = s.timing || {}; const c = s.cost || {}; return { input: v.inputTokens, output: v.outputTokens, cacheRead: v.cacheReadInputTokens, cacheWrite: v.cacheCreationInputTokens, reasoning: v.reasoningOutputTokens, ttft: t.ttftMs, total: t.totalMs, tier: c.priceTierApplied, ver: c.pricingVersion, cost: c.totalCostUsd }; }
async function switchView(name) { view.value = name; if (name === 'profile') profile.value = await loadProfile('me'); if (name === 'ledger') ledger.value = null; }
async function feedback(rating) { if (!current.value) return; await sendFeedback(current.value, rating, null); feedbackSent.value = true; openFeedback.value = false; }
onMounted(async () => { await loadConfig(); await loadSessions(); if (sessions.value[0]) await select(sessions.value[0].sessionId); });
const copy = (t) => { navigator.clipboard && navigator.clipboard.writeText(t); };
</script>

<template>
  <header class="topbar">
    <span class="brand">mazi<em>·</em>harness</span>
    <span class="dim" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ cfgText }}</span>
    <span class="status"><i class="dot" :class="busy ? 'busy' : cfg && cfg.providers.length ? 'ok' : 'bad'"></i><span id="apilog" class="dim"></span></span>
  </header>
  <main class="layout">
    <aside class="col" style="width:260px;border-right:1px solid var(--line)">
      <div style="padding:10px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px">
        <input placeholder="搜索会话…" v-model="q" />
        <button class="primary" @click="openNew">＋ 新建会话</button>
      </div>
      <ul class="list">
        <li v-for="s in sessions.filter((x) => !q || String(x.title || x.input).toLowerCase().includes(q.toLowerCase()))" :key="s.sessionId" :class="{ active: current === s.sessionId }" @click="select(s.sessionId)">
          <div style="color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ esc(s.title || s.input) }}</div>
          <div class="muted" style="font-size:11px;display:flex;gap:8px"><span class="badge" :class="badge(s.outcome)">{{ s.outcome || 'running' }}</span><span>{{ s.turns ?? '-' }} turns</span><span>{{ fmtUsd(s.costUsd) }}</span></div>
        </li>
        <li v-if="!sessions.length" class="muted">暂无会话</li>
      </ul>
      <div class="row" style="padding:8px 10px;border-top:1px solid var(--line)">
        <button class="navbtn" :class="view === 'chat' && 'on'" @click="switchView('chat')">会话</button>
        <button class="navbtn" :class="view === 'profile' && 'on'" @click="switchView('profile')">画像</button>
        <button class="navbtn" :class="view === 'ledger' && 'on'" @click="switchView('ledger')">账本</button>
        <button class="navbtn" @click="switchView('settings')">设置</button>
      </div>
    </aside>
    <section class="col main" style="min-width:0">
      <template v-if="view === 'chat'">
        <div style="padding:12px 14px 6px;display:flex;gap:8px;align-items:flex-end">
          <textarea v-model="draft.statement" rows="2" style="flex:1" placeholder="任务描述，例如：读取 README.md 并汇报（Ctrl+Enter 运行）" @keydown.ctrl.enter="submitDraft(true)"></textarea>
          <button :disabled="busy" @click="submitDraft(false)">仅创建</button>
          <button class="primary" :disabled="busy" @click="submitDraft(true)">创建并运行</button>
        </div>
        <div v-if="ui.err" class="card" style="margin:8px 14px">{{ ui.err }}</div>
        <div v-if="detail" style="padding:2px 14px;border-bottom:1px solid var(--line)">
          <div class="row" style="justify-content:space-between">
            <div><b>{{ esc(detail.rawIntent) }}</b> <span class="muted">session {{ detail.sessionId }}</span></div>
            <div class="row"><button v-if="isCanRun" :disabled="busy" @click="runCurrent(detail.sessionId)">▶ 执行</button><button v-if="detail.outcome" @click="openFeedback = true">反馈</button><button @click="copy(detail.sessionId)" title="复制 Session ID">⧉</button></div>
          </div>
          <div class="seg" style="margin:4px 0"><button :class="mainTab === 'chat' && 'on'" @click="mainTab = 'chat'">对话流</button><button :class="mainTab === 'traj' && 'on'" @click="mainTab = 'traj'">轨迹</button></div>
        </div>
        <div class="scroll" style="flex:1;padding:10px 14px;display:flex;flex-direction:column;gap:6px">
          <template v-if="mainTab === 'chat' && detail && detail.turns">
            <template v-for="turn in detail.turns" :key="turn.turnId"><div class="card" style="background:var(--panel2)"><b>Turn</b> {{ esc((turn.contract && turn.contract.statement) || turn.turnId) }} <span class="muted">status {{ turn.status }} · attempt {{ turn.attempt }}</span></div>
              <div v-for="s in turn.steps" :key="s.stepId" class="step" :class="{ open: stepOpen[s.stepId] }" @click="toggleStep(s.stepId); showAudit(turn, s)">
                <div class="row"><span>{{ icon(s.kind) }}</span><span>{{ esc(stepTitle(s)) }}</span><span class="muted" style="font-size:11px">#{{ s.seq }} · {{ s.status }}{{ s.model ? ' · ' + s.model.modelId : '' }}</span></div>
                <pre>{{ JSON.stringify({ payload: s.payload, usage: s.usage }, null, 2) }}</pre>
              </div>
            </template>
          </template>
          <template v-else-if="mainTab === 'traj' && detail && detail.turns">
            <div class="row" style="gap:4px;flex-wrap:wrap"><span v-for="f in ['all','thinking','tool_call','observation','policy','provider']" :key="f" class="filter-chip" :class="trajFilter === f && 'on'" @click="trajFilter = f">{{ f }}</span></div>
            <div v-for="turn in detail.turns" :key="turn.turnId" style="margin-top:4px">
              <div class="card" style="background:var(--panel2)">Turn {{ esc((turn.contract && turn.contract.statement) || turn.turnId) }}</div>
              <div v-for="s in turn.steps.filter((x) => trajFilter === 'all' || x.kind === trajFilter)" :key="s.stepId" class="row muted" style="margin:2px 0 0 10px;cursor:pointer" @click="showAudit(turn, s); rightTab = 'audit'">{{ icon(s.kind) }} <span style="color:var(--fg)">{{ esc(stepTitle(s)) }}</span> <span style="font-size:11px">#{{ s.seq }} {{ s.status }}{{ s.model ? ' · ' + s.model.modelId : '' }}</span></div>
            </div>
          </template>
          <div v-else-if="detail" class="muted">（空会话：点击 ▶ 执行）</div>
          <div v-if="openFeedback" class="card row" style="align-items:center;justify-content:space-between"><span>这个结果有帮助吗？</span><span class="row"><button @click="feedback(5)">👍</button><button @click="feedback(1)">👎</button><button @click="openFeedback = false">✕</button></span></div>
        </div>
      </template>
      <template v-else-if="view === 'settings'">
        <div class="card" style="margin:16px"><h3 class="lbl">设置</h3><div class="field"><label>数据目录</label><input :value="cfg ? cfg.home : ''" readonly /></div><div class="field"><label>存储</label><input :value="cfg ? cfg.storage.driver + ' · ' + cfg.storage.db : ''" readonly /></div><div class="field"><label>Provider</label><div>{{ cfg ? cfg.providers.join(', ') : '-' }}</div></div><div class="muted">配置保存在 ~/.mazi（providers/tools/flags.json）。修改后重启 server。</div></div>
      </template>
      <template v-else-if="view === 'profile'">
        <div class="card" style="margin:16px"><h3 class="lbl">用户画像</h3><pre class="mono">{{ profile ? JSON.stringify(profile, null, 2) : '暂无数据（在顶部输入 userId 运行后可聚合）' }}</pre></div>
      </template>
      <template v-else>
        <div class="card" style="margin:16px"><h3 class="lbl">失败分类账</h3><div class="muted">failure_ledger 将在存储 SPI（BE-8）落地后提供；当前可从“执行失败”的会话查看轨迹定位。</div></div>
      </template>
    </section>
    <aside class="col" style="width:340px;border-left:1px solid var(--line)">
      <div class="seg"><button :class="rightTab === 'audit' && 'on'" @click="rightTab = 'audit'">审计</button><button :class="rightTab === 'events' && 'on'" @click="rightTab = 'events'">事件</button></div>
      <div v-show="rightTab === 'audit'" class="scroll" style="flex:1;padding:10px">
        <div class="seg" style="margin-bottom:8px"><button v-for="v in ['declared','authorized','actual','usage']" :key="v" :class="auditView === v && 'on'" @click="auditView = v">{{ { declared: '声明', authorized: '授权', actual: '实际', usage: '用量' }[v] }}</button></div>
        <template v-if="ui.audit && ui.audit.step">
          <pre v-if="auditView !== 'usage'" class="mono">{{ auditView === 'declared' ? JSON.stringify((ui.audit.turn && ui.audit.turn.contract) || {}, null, 2) : auditView === 'authorized' ? JSON.stringify((ui.audit.turn && ui.audit.turn.capacity) || {}, null, 2) : triple() }}</pre>
          <template v-else>
            <div v-for="seg in usageSegs()" :key="seg.k" class="row muted" style="justify-content:space-between"><span>{{ seg.k }}</span><span>{{ seg.v }}</span></div>
            <div class="bar" style="margin:6px 0"><i v-for="seg in usageSegs()" :key="seg.k" :style="{ width: seg.w + '%', background: seg.c }"></i></div>
            <div v-if="vendorStats()" class="muted" style="font-size:11px">vendor: in {{ vendorStats().input }} / out {{ vendorStats().output }}{{ vendorStats().reasoning ? ' / r ' + vendorStats().reasoning : '' }}<br/>timing: ttft {{ vendorStats().ttft || 0 }}ms · {{ vendorStats().total || 0 }}ms<br/>cost {{ fmtUsd(vendorStats().cost) }} · tier {{ vendorStats().tier }} · {{ vendorStats().ver }}</div>
          </template>
        </template>
        <div v-else class="muted">点击左侧 Step 查看声明/授权/实际/用量</div>
      </div>
      <div v-show="rightTab === 'events'" class="scroll" style="flex:1;padding:10px">
        <pre class="mono">{{ filteredEvents.slice(-500).map((e) => e.type + '  ' + [e.sessionId, e.turnId, e.stepId].filter(Boolean).join('/')).join(String.fromCharCode(10)) }}</pre>
        <div class="muted">{{ events.list.length }} events</div>
      </div>
    </aside>
  </main>
  <footer class="bottom">
    <span>turns <b>{{ metrics.turns }}</b></span><span>steps <b>{{ metrics.steps }}</b></span><span>tokens <b>{{ metrics.tokens }}</b></span><span>cost <b>{{ fmtUsd(metrics.cost) }}</b></span><span class="muted">{{ metrics.provider }} / {{ metrics.model }}</span>
    <span v-if="budgetPct !== null" class="muted" style="margin-left:auto">预算 {{ budgetPct }}%</span>
  </footer>
  <div v-if="showNew" class="modal-mask" @click.self="showNew = false">
    <div class="modal"><h3 class="lbl">新建会话 · GoalContract</h3>
      <div class="field"><label>任务</label><textarea v-model="draft.statement" rows="3" placeholder="目标陈述"></textarea></div>
      <div class="grid2"><div class="field"><label>权限上限</label><select v-model="draft.permission"><option v-for="p in ['text','read-only','draft','approved','autonomous']" :key="p" :value="p">{{ p }}</option></select></div>
      <div class="field"><label>预算（USD）</label><input type="number" v-model.number="draft.budgetUsd" step="0.1" /></div>
      <div class="field"><label>最大步数</label><input type="number" v-model.number="draft.maxSteps" /></div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button @click="showNew = false">取消</button><button class="primary" @click="submitDraft(true)">创建并运行</button><button @click="submitDraft(false)">仅创建</button></div>
    </div>
  </div>
</template>