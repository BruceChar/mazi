<script setup>
/**
 * ExperimentsPage — AB 实验室（对照实验，docs/AB测试设计.md §9.2）。
 *
 * 前台执行、与主对话同一条执行面：
 *   1. 「运行」先 POST /api/experiments 建好两臂 Goal 会话（拿到两个 rootGoalId）；
 *   2. 立刻为左右两个窗口订阅 /api/events/:rootGoalId?follow=1 —— 实时看 thinking / 工具 / 观察；
 *   3. 再 POST /api/experiments/:id/run（前台请求，两臂并行）；期间审批会实时弹出并可应答；
 *   4. 结束后刷新折叠视图：指标、Trace、输出并排 diff、复盘。
 */
import { diffText } from '@mazi/libs';
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { API_BASE } from '../api.js';
import LineIcon from '../assets/LineIcon.vue';
import {
    applyArmEvent,
    ARM_EVENT_TYPES,
    armStreamText,
    initialArmLive,
} from '../scripts/arm-live.ts';
import { PERMISSION_LEVELS } from '../scripts/goal-contract.ts';
import {
    armConfigSummary,
    armFeatureLabels,
    armStatusLabel,
    betterLabel,
    buildExperimentSpec,
    EXPERIMENT_KIND_LABELS,
    experimentStatusLabel,
    formatDelta,
    formatDeltaPct,
    formatMetric,
    traceRounds,
    traceToolRows,
    variableFormula,
} from '../scripts/experiments.ts';
import {
    cfg,
    deleteExperiment,
    executeExperiment,
    experimentRunning,
    experiments,
    experimentViews,
    fetchArmTrace,
    features,
    freeChatWorkspace,
    loadConfig,
    loadExperimentDetail,
    loadExperiments,
    loadFeatures,
    loadSkillOptions,
    loadWorkspace,
    planExperiment,
    projects,
    rerunExperiment,
    respondApproval,
    reviewExperiment,
    skillOptions,
    workspaceRoot,
} from '../scripts/store.js';

const selectedId = ref('');
const traces = reactive({});
/** label -> ArmLive（实时投影，见 arm-live.ts）。 */
const live = reactive({});
/** label -> EventSource（非响应式，仅用于清理）。 */
const sources = {};
const error = ref('');
const notice = ref('');
const reviewNote = ref('');
const reviewVerdict = ref('inconclusive');
const openAnswers = reactive({});

const REASONING_LEVELS = ['off', 'low', 'medium', 'high'];
const VERDICTS = ['inconclusive', 'A', 'B', 'tie'];

const form = reactive({
    title: '',
    hypothesis: '',
    input: '',
    workspace: '',
    kind: 'feature',
    modelA: '',
    modelB: '',
    featureId: '',
    skillsA: [],
    skillsB: [],
    reasoningA: 'low',
    reasoningB: 'high',
    permissionA: 'read-only',
    permissionB: 'draft',
});

const selected = computed(() => {
    const id = selectedId.value;
    return id ? (experimentViews[id] ?? null) : null;
});

const pendingArms = computed(
    () =>
        selected.value?.arms.filter(
            (arm) => arm.rootGoalId && (arm.status === 'pending' || arm.status === 'running'),
        ) ?? [],
);

const modelOptions = computed(() => {
    const providers = cfg.value?.providers || [];
    return providers.flatMap((provider) =>
        (provider.models || []).map((model) => ({
            id: model.id,
            label: (model.name || model.id) + ' · ' + provider.id,
        })),
    );
});

/** 当前生效工作区（已选中优先，否则随心聊默认）。 */
const currentWorkspacePath = computed(() => workspaceRoot.value || freeChatWorkspace.value);

/** 工作区选择项：跟随当前 + 已有项目工作区 + 随心聊默认（按路径去重，展示路径名称）。 */
const workspaceOptions = computed(() => {
    const current = currentWorkspacePath.value;
    const options = [
        { value: '', label: current ? '跟随当前工作区（' + current + '）' : '跟随当前工作区' },
    ];
    const seen = new Set(['']);
    for (const project of projects.value) {
        if (!project?.path || project.path === current || seen.has(project.path)) continue;
        seen.add(project.path);
        options.push({ value: project.path, label: project.title + '（' + project.path + '）' });
    }
    if (freeChatWorkspace.value && !seen.has(freeChatWorkspace.value)) {
        seen.add(freeChatWorkspace.value);
        options.push({
            value: freeChatWorkspace.value,
            label: '随心聊默认（' + freeChatWorkspace.value + '）',
        });
    }
    return options;
});

/** 本次实验实际使用的工作区路径。 */
const resolvedWorkspace = computed(
    () => form.workspace || currentWorkspacePath.value || '（未指定，跟随后端当前工作区）',
);

const diffSummary = computed(() => {
    const comparison = selected.value?.comparison;
    if (!comparison) return null;
    return diffText(comparison.outputs.a, comparison.outputs.b);
});

const diffRows = computed(() => diffSummary.value?.rows ?? []);

const kindOptions = Object.entries(EXPERIMENT_KIND_LABELS);

onMounted(async () => {
    if (!cfg.value) await loadConfig();
    await Promise.all([loadExperiments(), loadFeatures(), loadWorkspace(), loadSkillOptions()]);
    form.featureId = features.value[0]?.id || '';
    form.modelA = modelOptions.value[0]?.id || '';
    form.modelB = modelOptions.value[1]?.id || modelOptions.value[0]?.id || '';
    if (experiments.value[0]) await select(experiments.value[0].experimentId);
});

onBeforeUnmount(closeAllArms);

/* ---- 实时：每臂一个 SSE 订阅（前台可见，审批可应答） ---- */

function watchArm(arm) {
    if (!arm.rootGoalId) return;
    closeArm(arm.label);
    live[arm.label] = initialArmLive('running');
    if (typeof EventSource === 'undefined') return;
    const url = API_BASE + '/api/events/' + encodeURIComponent(arm.rootGoalId) + '?follow=1';
    const source = new EventSource(url);
    const consume = (raw) => {
        try {
            const parsed = JSON.parse(raw.data);
            live[arm.label] = applyArmEvent(live[arm.label] ?? initialArmLive('running'), parsed);
        } catch {
            // 坏帧忽略：事件流以 step.ended 为准。
        }
    };
    for (const type of ARM_EVENT_TYPES) source.addEventListener(type, consume);
    sources[arm.label] = source;
}

function closeArm(label) {
    const source = sources[label];
    if (source) {
        source.close();
        delete sources[label];
    }
}

function closeAllArms() {
    for (const label of Object.keys(sources)) closeArm(label);
}

async function select(experimentId) {
    if (experimentId !== selectedId.value) closeAllArms();
    selectedId.value = experimentId;
    error.value = '';
    notice.value = '';
    if (!experimentViews[experimentId]) await loadExperimentDetail(experimentId);
    await loadTraces();
}

async function loadTraces() {
    for (const key of Object.keys(traces)) delete traces[key];
    const view = selected.value;
    if (!view) return;
    await Promise.all(
        view.arms
            .filter((arm) => arm.rootGoalId)
            .map(async (arm) => {
                traces[arm.label] = await fetchArmTrace(arm.rootGoalId);
            }),
    );
}

/** 开窗订阅两臂事件流，然后前台执行（请求保持到两臂结束）。 */
async function startRun(experimentId, arms) {
    for (const arm of arms) watchArm(arm);
    await executeExperiment(experimentId);
}

async function submit() {
    error.value = '';
    notice.value = '';
    const draft = buildExperimentSpec(form);
    if (draft.error) {
        error.value = draft.error;
        return;
    }
    try {
        const planned = await planExperiment(draft.spec);
        await select(planned.experimentId);
        await startRun(planned.experimentId, planned.arms);
        await select(planned.experimentId);
        notice.value = '实验完成：' + planned.experimentId;
    } catch (err) {
        error.value = String(err);
    } finally {
        closeAllArms();
    }
}

/** 继续执行一次「已创建但未跑完」的实验（刷新页面后也能接着跑）。 */
async function resumeSelected() {
    const view = selected.value;
    if (!view || experimentRunning.value) return;
    error.value = '';
    notice.value = '';
    try {
        await startRun(view.experimentId, pendingArms.value);
        await select(view.experimentId);
        notice.value = '实验完成：' + view.experimentId;
    } catch (err) {
        error.value = String(err);
    } finally {
        closeAllArms();
    }
}

async function rerun() {
    const view = selected.value;
    if (!view || experimentRunning.value) return;
    error.value = '';
    notice.value = '';
    try {
        const next = await rerunExperiment(view.experimentId);
        await select(next.experimentId);
        await startRun(next.experimentId, next.arms);
        await select(next.experimentId);
        notice.value = '已重跑为新实验：' + next.experimentId;
    } catch (err) {
        error.value = String(err);
    } finally {
        closeAllArms();
    }
}

/** 行内应答审批（允许一次 / 本会话 / 拒绝）。 */
async function decide(approval, decision, scope) {
    try {
        await respondApproval(approval.invocationId, decision, scope);
    } catch (err) {
        error.value = String(err);
    }
}

async function removeSelected() {
    const view = selected.value;
    if (!view) return;
    if (!window.confirm('删除实验日志「' + view.title + '」？Goal/Trace 事实不会被删除。')) return;
    closeAllArms();
    try {
        await deleteExperiment(view.experimentId);
        selectedId.value = '';
    } catch (err) {
        error.value = String(err);
    }
}

async function submitReview() {
    const view = selected.value;
    if (!view) return;
    if (reviewNote.value.trim().length === 0) {
        error.value = '请填写复盘结论';
        return;
    }
    error.value = '';
    try {
        await reviewExperiment(view.experimentId, reviewNote.value.trim(), reviewVerdict.value);
        reviewNote.value = '';
        notice.value = '复盘已记录';
    } catch (err) {
        error.value = String(err);
    }
}

function toggleAnswer(label) {
    openAnswers[label] = !openAnswers[label];
}

function kpis(arm) {
    const metrics = arm.metrics;
    if (!metrics) return [];
    return [
        { label: '结局', value: formatMetric(metrics.ok, '') },
        { label: '成本', value: formatMetric(metrics.costUsd, 'USD') },
        { label: '输入 token', value: formatMetric(metrics.inputTokens, 'tok') },
        { label: '输出 token', value: formatMetric(metrics.outputTokens, 'tok') },
        { label: 'Step', value: formatMetric(metrics.steps, '') },
        { label: '工具调用', value: formatMetric(metrics.toolCalls, '') },
        { label: '模型轮次', value: formatMetric(metrics.modelRounds, '') },
        { label: '总耗时', value: formatMetric(metrics.durationMs, 'ms') },
        { label: '首 token', value: formatMetric(metrics.ttftMs, 'ms') },
    ];
}

function isLive(label) {
    const state = live[label];
    if (!state) return false;
    return (
        state.status === 'running' ||
        state.steps.length > 0 ||
        state.approvals.length > 0 ||
        armStreamText(state).length > 0
    );
}
</script>

<template>
    <div class="experiments-page">
        <div class="layout">
            <!-- 历史实验 -->
            <aside class="history">
                <div class="history-head">历史实验（{{ experiments.length }}）</div>
                <ul>
                    <li
                        v-for="item in experiments"
                        :key="item.experimentId"
                        :class="{ active: item.experimentId === selectedId }"
                        @click="select(item.experimentId)"
                    >
                        <div class="row-top">
                            <span class="hist-title">{{ item.title }}</span>
                            <span class="badge" :class="item.status">{{ experimentStatusLabel(item.status) }}</span>
                        </div>
                        <div class="hist-input">{{ item.input }}</div>
                        <div class="hist-meta">
                            {{ new Date(item.createdAt).toLocaleString() }} ·
                            {{ item.arms.map((arm) => arm.label + ':' + armStatusLabel(arm.status)).join(' / ') }}
                            <template v-if="item.reviewCount"> · 复盘 {{ item.reviewCount }}</template>
                        </div>
                    </li>
                    <li v-if="!experiments.length" class="empty">暂无实验</li>
                </ul>
            </aside>

            <section class="main">
                <!-- 新建 -->
                <div class="card create">
                    <div class="card-head">新建对照实验</div>
                    <div class="grid two">
                        <label>标题<input v-model="form.title" placeholder="Feature 增益：简洁作答" /></label>
                        <label>假设（可选）<input v-model="form.hypothesis" placeholder="打开开关可降低输出长度" /></label>
                    </div>
                    <label class="full">两臂共用的输入
                        <textarea v-model="form.input" rows="3" placeholder="同一个任务描述，两臂收到完全相同的输入" />
                    </label>
                    <div class="grid two">
                        <label>自变量
                            <select v-model="form.kind">
                                <option v-for="[kind, label] in kindOptions" :key="kind" :value="kind">{{ label }}</option>
                            </select>
                        </label>
                        <label>工作区
                            <select v-model="form.workspace">
                                <option v-for="option in workspaceOptions" :key="option.value" :value="option.value">
                                    {{ option.label }}
                                </option>
                            </select>
                        </label>
                    </div>
                    <div class="hint workspace-hint">本次实验工作区：{{ resolvedWorkspace }}</div>

                    <!-- Skill 自变量：从已发现列表多选（两臂独立，不用手输） -->
                    <div v-if="form.kind === 'skill'" class="skill-picker">
                        <div class="skill-col">
                            <div class="skill-col-head">基线 A 技能</div>
                            <label v-for="skill in skillOptions" :key="'a-' + skill.id" class="skill-item">
                                <input v-model="form.skillsA" type="checkbox" :value="skill.id" />
                                <span class="skill-name">{{ skill.name }}</span>
                                <code>{{ skill.id }}</code>
                                <span class="skill-tag">{{ skill.mounted ? '已挂载' : skill.scope }}</span>
                            </label>
                            <div v-if="!skillOptions.length" class="muted">未发现 Skill（设置 → Skills 可新建）</div>
                        </div>
                        <div class="skill-col">
                            <div class="skill-col-head">处理 B 技能</div>
                            <label v-for="skill in skillOptions" :key="'b-' + skill.id" class="skill-item">
                                <input v-model="form.skillsB" type="checkbox" :value="skill.id" />
                                <span class="skill-name">{{ skill.name }}</span>
                                <code>{{ skill.id }}</code>
                                <span class="skill-tag">{{ skill.mounted ? '已挂载' : skill.scope }}</span>
                            </label>
                            <div v-if="!skillOptions.length" class="muted">—</div>
                        </div>
                    </div>
                    <div v-if="form.kind === 'skill'" class="hint">
                        两臂技能集合互相独立，并覆盖该臂的全局挂载；两臂都空选 = 都不带技能。
                    </div>

                    <div v-else-if="form.kind === 'feature'" class="grid two">
                        <label>对照 Feature
                            <select v-model="form.featureId">
                                <option value="">（选择特性）</option>
                                <option v-for="feature in features" :key="feature.id" :value="feature.id">
                                    {{ feature.name }}（{{ feature.id }}）
                                </option>
                            </select>
                        </label>
                        <label>取值
                            <input :value="'A = 关闭 · B = 开启'" disabled />
                        </label>
                    </div>

                    <div v-else-if="form.kind === 'model'" class="grid two">
                        <label>基线 A 模型
                            <select v-model="form.modelA">
                                <option v-for="option in modelOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
                            </select>
                        </label>
                        <label>处理 B 模型
                            <select v-model="form.modelB">
                                <option v-for="option in modelOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
                            </select>
                        </label>
                    </div>

                    <div v-else-if="form.kind === 'reasoning'" class="grid two">
                        <label>基线 A 推理强度
                            <select v-model="form.reasoningA">
                                <option v-for="level in REASONING_LEVELS" :key="level" :value="level">{{ level }}</option>
                            </select>
                        </label>
                        <label>处理 B 推理强度
                            <select v-model="form.reasoningB">
                                <option v-for="level in REASONING_LEVELS" :key="level" :value="level">{{ level }}</option>
                            </select>
                        </label>
                    </div>

                    <div v-else class="grid two">
                        <label>基线 A 权限档位
                            <select v-model="form.permissionA">
                                <option v-for="level in PERMISSION_LEVELS" :key="level" :value="level">{{ level }}</option>
                            </select>
                        </label>
                        <label>处理 B 权限档位
                            <select v-model="form.permissionB">
                                <option v-for="level in PERMISSION_LEVELS" :key="level" :value="level">{{ level }}</option>
                            </select>
                        </label>
                    </div>
                    <div class="create-actions">
                        <span class="hint">点运行后左右两窗同时前台执行；审批会实时弹出，不会卡在后台。</span>
                        <button class="btn primary" :disabled="experimentRunning" @click="submit">
                            <LineIcon name="play" size="13" />{{ experimentRunning ? '运行中…' : '运行对照实验' }}
                        </button>
                    </div>
                </div>

                <div v-if="error" class="notice error">{{ error }}</div>
                <div v-else-if="notice" class="notice ok">{{ notice }}</div>

                <div v-if="!selected" class="card empty-card">从左侧选择一次实验，或在上方新建。</div>

                <template v-else>
                    <div class="card">
                        <div class="detail-head">
                            <div class="title-row">
                                <span class="detail-title">{{ selected.title }}</span>
                                <span class="badge" :class="selected.status">{{ experimentStatusLabel(selected.status) }}</span>
                                <span class="mono">{{ selected.experimentId }}</span>
                            </div>
                            <div class="actions">
                                <button
                                    v-if="pendingArms.length && !experimentRunning"
                                    class="btn primary"
                                    @click="resumeSelected"
                                >
                                    <LineIcon name="play" size="13" />继续运行（{{ pendingArms.length }} 臂待跑）
                                </button>
                                <button class="btn" :disabled="experimentRunning" @click="rerun">
                                    <LineIcon name="refresh" size="13" />重跑
                                </button>
                                <button class="btn danger" @click="removeSelected">
                                    <LineIcon name="trash" size="13" />删除
                                </button>
                            </div>
                        </div>
                        <div class="detail-meta">
                            <span>{{ new Date(selected.createdAt).toLocaleString() }}</span>
                            <span v-if="selected.endedAt">· 用时 {{ formatMetric(selected.endedAt - selected.createdAt, 'ms') }}</span>
                            <span v-if="selected.workspace">· 工作区 {{ selected.workspace }}</span>
                        </div>
                        <div v-if="selected.hypothesis" class="hypothesis">假设：{{ selected.hypothesis }}</div>
                        <div class="input-line">输入：{{ selected.input }}</div>
                        <div class="variables">
                            <span v-for="variable in selected.variables" :key="variable.kind" class="setting-badge">
                                {{ variableFormula(variable) }}
                            </span>
                        </div>
                    </div>

                    <!-- 两臂并排（前台执行，实时可见） -->
                    <div class="arms">
                        <div v-for="arm in selected.arms" :key="arm.label" class="card arm">
                            <div class="arm-head">
                                <span class="arm-label">臂 {{ arm.label }}</span>
                                <span class="badge" :class="arm.status">{{ armStatusLabel(arm.status) }}</span>
                            </div>
                            <div class="arm-config">{{ armConfigSummary(arm) }}</div>
                            <div v-if="armFeatureLabels(arm).length" class="tags">
                                <span v-for="id in armFeatureLabels(arm)" :key="id" class="setting-badge">开关 {{ id }}</span>
                            </div>
                            <div v-if="arm.error" class="notice error small">{{ arm.error }}</div>

                            <!-- 实时执行：thinking / 工具 / 观察 + 行内审批 -->
                            <div v-if="isLive(arm.label)" class="live">
                                <div class="block-head">
                                    实时执行
                                    <span class="badge" :class="live[arm.label].status">
                                        {{ armStatusLabel(live[arm.label].status) }}
                                    </span>
                                </div>
                                <pre v-if="armStreamText(live[arm.label])" class="stream">{{ armStreamText(live[arm.label]) }}</pre>
                                <div v-if="live[arm.label].error" class="notice error small">{{ live[arm.label].error }}</div>
                                <ul class="live-steps">
                                    <li
                                        v-for="step in live[arm.label].steps"
                                        :key="step.stepId"
                                        :class="step.status"
                                    >
                                        <span class="step-kind">{{ step.kind === 'invocation' ? '工具' : '思考' }}</span>
                                        <span class="step-title">{{ step.title || step.content }}</span>
                                        <span class="step-status">{{ step.status }}</span>
                                    </li>
                                </ul>
                                <div
                                    v-for="approval in live[arm.label].approvals"
                                    :key="approval.invocationId"
                                    class="approval"
                                >
                                    <div class="approval-text">
                                        需要人工审批：<code>{{ approval.toolName }}</code>
                                        {{ approval.summary }}
                                    </div>
                                    <div class="approval-actions">
                                        <button class="btn primary" @click="decide(approval, 'granted', 'once')">允许一次</button>
                                        <button class="btn" @click="decide(approval, 'granted', 'session')">本会话允许</button>
                                        <button class="btn danger" @click="decide(approval, 'rejected')">拒绝</button>
                                    </div>
                                </div>
                            </div>

                            <div class="kpis">
                                <div v-for="kpi in kpis(arm)" :key="kpi.label" class="kpi">
                                    <span class="kpi-label">{{ kpi.label }}</span>
                                    <span class="kpi-value">{{ kpi.value }}</span>
                                </div>
                            </div>

                            <div class="block-head">
                                最终输出
                                <button class="link-btn" @click="toggleAnswer(arm.label)">
                                    {{ openAnswers[arm.label] ? '收起' : '展开全文' }}
                                </button>
                            </div>
                            <pre class="answer" :class="{ open: openAnswers[arm.label] }">{{ arm.metrics?.finalAnswer || '（无输出）' }}</pre>

                            <div class="block-head">Trace · 模型轮次</div>
                            <table class="mini">
                                <thead>
                                    <tr><th>#</th><th>模型</th><th>输入</th><th>输出</th><th>成本</th><th>耗时</th><th>输出字符</th></tr>
                                </thead>
                                <tbody>
                                    <tr v-for="row in traceRounds(traces[arm.label])" :key="row.index">
                                        <td>{{ row.index }}</td>
                                        <td>{{ row.model }}</td>
                                        <td>{{ row.inputTokens }}</td>
                                        <td>{{ row.outputTokens }}</td>
                                        <td>{{ formatMetric(row.costUsd, 'USD') }}</td>
                                        <td>{{ formatMetric(row.durationMs, 'ms') }}</td>
                                        <td>{{ row.answerChars }}</td>
                                    </tr>
                                    <tr v-if="!traceRounds(traces[arm.label]).length">
                                        <td colspan="7" class="muted">无轮次事实</td>
                                    </tr>
                                </tbody>
                            </table>

                            <div class="block-head">Trace · 工具调用</div>
                            <ul class="tools">
                                <li v-for="(tool, index) in traceToolRows(traces[arm.label])" :key="index">
                                    <code>{{ tool.toolName }}</code>
                                    <span v-if="tool.cwd" class="muted">{{ tool.cwd }}</span>
                                    <div class="tool-out">{{ tool.output || '（空输出）' }}</div>
                                </li>
                                <li v-if="!traceToolRows(traces[arm.label]).length" class="muted">未调用工具</li>
                            </ul>
                        </div>
                    </div>

                    <!-- 对比 -->
                    <div v-if="selected.comparison" class="card">
                        <div class="card-head">
                            指标对比
                            <span class="muted">（{{ selected.comparison.note }}）</span>
                        </div>
                        <table class="compare">
                            <thead>
                                <tr><th>指标</th><th>A</th><th>B</th><th>Δ (B−A)</th><th>Δ%</th><th>优者</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="metric in selected.comparison.metrics" :key="metric.key">
                                    <td>{{ metric.label }}</td>
                                    <td>{{ formatMetric(metric.a, metric.unit) }}</td>
                                    <td>{{ formatMetric(metric.b, metric.unit) }}</td>
                                    <td>{{ formatDelta(metric) }}</td>
                                    <td>{{ formatDeltaPct(metric) }}</td>
                                    <td><span class="badge" :class="'better-' + metric.better">{{ betterLabel(metric.better) }}</span></td>
                                </tr>
                            </tbody>
                        </table>
                        <div class="block-head">
                            输出并排 diff
                            <span v-if="selected.comparison.outputs.identical" class="muted">两臂输出逐字符相同</span>
                            <span v-else-if="diffSummary" class="muted">
                                相似度 {{ (diffSummary.similarity * 100).toFixed(1) }}% · 新增 {{ diffSummary.added }} 行 · 删除 {{ diffSummary.removed }} 行
                            </span>
                        </div>
                        <div v-if="!selected.comparison.outputs.identical" class="diff">
                            <div v-for="(row, index) in diffRows" :key="index" class="diff-row" :class="row.op">
                                <span class="ln">{{ row.aLine ?? '' }}</span>
                                <span class="cell">{{ row.a ?? '' }}</span>
                                <span class="ln">{{ row.bLine ?? '' }}</span>
                                <span class="cell">{{ row.b ?? '' }}</span>
                            </div>
                        </div>
                    </div>

                    <!-- 复盘 -->
                    <div class="card">
                        <div class="card-head">复盘（append-only）</div>
                        <div class="review-form">
                            <select v-model="reviewVerdict">
                                <option v-for="verdict in VERDICTS" :key="verdict" :value="verdict">
                                    {{ verdict === 'A' ? 'A 更优' : verdict === 'B' ? 'B 更优' : verdict === 'tie' ? '持平' : '不确定' }}
                                </option>
                            </select>
                            <input v-model="reviewNote" placeholder="这次对照的结论 / 下一步" @keyup.enter="submitReview" />
                            <button class="btn" @click="submitReview">记录</button>
                        </div>
                        <ul class="reviews">
                            <li v-for="(review, index) in selected.reviews" :key="index">
                                <span class="badge">{{ review.verdict }}</span>
                                <span class="review-note">{{ review.note }}</span>
                                <span class="muted">{{ new Date(review.at).toLocaleString() }}</span>
                            </li>
                            <li v-if="!selected.reviews.length" class="muted">尚无复盘记录。</li>
                        </ul>
                    </div>
                </template>
            </section>
        </div>
    </div>
</template>

<style scoped>
.experiments-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 12px 16px 16px;
    gap: 10px;
    overflow: hidden;
}
.layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 12px;
}
.history {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius);
    background: var(--bg-panel);
    overflow-y: auto;
    min-height: 0;
}
.history-head {
    position: sticky;
    top: 0;
    padding: 8px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-secondary);
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border-soft);
}
.history ul {
    list-style: none;
    margin: 0;
    padding: 6px;
}
.history li {
    padding: 7px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
}
.history li:hover {
    background: var(--bg-hover);
}
.history li.active {
    background: var(--bg-active);
}
.row-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
}
.hist-title {
    font-size: 13px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.hist-input {
    margin-top: 3px;
    font-size: 12px;
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.hist-meta {
    margin-top: 3px;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.main {
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-right: 4px;
}
.card {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius);
    background: var(--bg-panel);
    padding: 12px;
}
.card-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
    margin-bottom: 8px;
}
.grid {
    display: grid;
    gap: 8px;
}
.grid.two {
    grid-template-columns: 1fr 1fr;
}
label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--fg-secondary);
}
label.full {
    margin-top: 8px;
}
input,
textarea,
select {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font-size: 12px;
    font-family: inherit;
}
input:disabled {
    color: var(--fg-tertiary);
}
.create-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
}
.hint {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-panel);
    color: var(--fg);
    font-size: 12px;
    cursor: pointer;
}
.btn:hover {
    background: var(--bg-hover);
}
.btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}
.btn.danger {
    color: var(--error);
}
.btn:disabled {
    opacity: 0.6;
    cursor: default;
}
.notice {
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
}
.notice.small {
    padding: 4px 8px;
    margin-top: 6px;
}
.notice.error {
    background: var(--error-soft);
    color: var(--error);
}
.notice.ok {
    background: var(--ok-soft);
    color: var(--ok);
}
.empty-card,
.empty,
.muted {
    color: var(--fg-tertiary);
    font-size: 12px;
}
.detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.title-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
}
.detail-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
}
.mono {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: var(--fg-tertiary);
}
.actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.detail-meta,
.hypothesis,
.input-line {
    margin-top: 6px;
    font-size: 12px;
    color: var(--fg-secondary);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}
.variables,
.tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
}
.arms {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    align-items: start;
}
.arm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.arm-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
}
.arm-config {
    margin-top: 4px;
    font-size: 12px;
    color: var(--fg-secondary);
}
/* 实时执行区：流式正文 + 步骤 + 行内审批 */
.live {
    margin-top: 10px;
    padding: 8px;
    border: 1px solid var(--accent-soft);
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.stream {
    margin: 0;
    padding: 6px 8px;
    max-height: 160px;
    overflow-y: auto;
    border-radius: var(--radius-sm);
    background: var(--bg-code, var(--bg-panel));
    color: var(--fg-secondary);
    font-size: 11px;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
}
.live-steps {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 180px;
    overflow-y: auto;
}
.live-steps li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11px;
    color: var(--fg-secondary);
}
.step-kind {
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 8px;
    background: var(--bg-hover);
    color: var(--fg-tertiary);
    font-size: 10px;
}
.step-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.step-status {
    color: var(--fg-tertiary);
    font-size: 10px;
}
.live-steps li.active .step-title {
    color: var(--fg);
}
.approval {
    margin-top: 8px;
    padding: 8px;
    border: 1px solid var(--warn);
    border-radius: var(--radius-sm);
    background: var(--warn-soft);
}
.approval-text {
    font-size: 12px;
    color: var(--fg);
}
.approval-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
}
.kpis {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 10px;
}
.kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg);
}
.kpi-label {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.kpi-value {
    font-size: 12px;
    color: var(--fg);
    font-family: ui-monospace, monospace;
}
.block-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin: 12px 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-secondary);
}
.link-btn {
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
}
.answer {
    margin: 0;
    padding: 8px;
    max-height: 96px;
    overflow: hidden;
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font-size: 12px;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
}
.answer.open {
    max-height: 480px;
    overflow-y: auto;
}
.mini,
.compare {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
}
.mini th,
.mini td,
.compare th,
.compare td {
    padding: 4px 6px;
    border-bottom: 1px solid var(--border-soft);
    text-align: left;
    color: var(--fg-secondary);
}
.mini th,
.compare th {
    color: var(--fg-tertiary);
    font-weight: 500;
}
.tools {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.tools li {
    font-size: 11px;
    color: var(--fg-secondary);
}
.tools code {
    font-family: ui-monospace, monospace;
    color: var(--fg);
    margin-right: 6px;
}
.tool-out {
    margin-top: 2px;
    color: var(--fg-tertiary);
    white-space: pre-wrap;
    word-break: break-word;
}
.badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--bg-hover);
    color: var(--fg-secondary);
    font-size: 11px;
    flex-shrink: 0;
}
.badge.completed,
.badge.better-A,
.badge.better-B {
    background: var(--ok-soft);
    color: var(--ok);
}
.badge.failed {
    background: var(--error-soft);
    color: var(--error);
}
.badge.aborted,
.badge.running {
    background: var(--warn-soft);
    color: var(--warn);
}
.badge.better-tie {
    background: var(--bg-hover);
    color: var(--fg-secondary);
}
.diff {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    overflow: hidden;
    font-family: ui-monospace, monospace;
    font-size: 11px;
}
.diff-row {
    display: grid;
    grid-template-columns: 34px 1fr 34px 1fr;
    gap: 0;
}
.diff-row .ln {
    padding: 2px 5px;
    color: var(--fg-tertiary);
    background: var(--bg);
    text-align: right;
}
.diff-row .cell {
    padding: 2px 6px;
    color: var(--fg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    border-bottom: 1px solid var(--border-soft);
}
.diff-row.add .cell:nth-of-type(2),
.diff-row.add .cell:last-child {
    background: var(--ok-soft);
    color: var(--ok);
}
.diff-row.remove .cell:first-of-type {
    background: var(--error-soft);
    color: var(--error);
}
.review-form {
    display: grid;
    grid-template-columns: 120px 1fr auto;
    gap: 8px;
}
.reviews {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.reviews li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.review-note {
    color: var(--fg);
}
.workspace-hint {
    margin-top: -2px;
}
/* Skill 自变量：双栏多选（从已发现列表选择，不用手输） */
.skill-picker {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
}
.skill-col {
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-sm);
    padding: 6px 8px;
    max-height: 190px;
    overflow-y: auto;
}
.skill-col-head {
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-secondary);
    margin-bottom: 4px;
}
.skill-col .skill-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
    font-size: 12px;
    color: var(--fg);
    cursor: pointer;
}
.skill-col .skill-item input {
    padding: 0;
    width: auto;
    margin: 0;
}
.skill-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.skill-item code {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.skill-tag {
    font-size: 10px;
    color: var(--fg-tertiary);
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    padding: 0 5px;
    flex-shrink: 0;
}
</style>
