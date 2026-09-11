<script setup>
import { computed, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { renderMarkdown } from '../scripts/markdown.ts';

const props = defineProps({
    runDetail: { type: Object, default: null },
    busy: { type: Boolean, default: false },
    /** In-flight streaming answer (token level) from store.activeLiveStream. */
    liveStream: { type: Object, default: null },
    /** Append-only live steps of the executing run (store.liveSteps[run]). */
    liveSteps: { type: Array, default: () => [] },
    /** Audit selection highlight (store.selectedStepId / selectedTaskId). */
    selectedStepId: { type: String, default: '' },
    selectedTaskId: { type: String, default: '' },
});
/** Open the right-side audit panel for the clicked Step/Task. */
const emit = defineEmits(['select-step', 'select-task']);

/* ---- Time formatting ---- */
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Time of day with milliseconds (HH:MM:SS.mmm); the date lives on the task header. */
function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Full date + time (YYYY-MM-DD HH:MM:SS), shown once per task. */
function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
function kindLabel(kind) {
    if (kind === 'thinking') return 'thinking';
    if (kind === 'intent') return 'intent';
    if (kind === 'tool_call') return 'tool';
    return kind || '-';
}
function statusLabel(status) {
    if (!status) return '';
    return status;
}

/* ---- Usage stats ---- */
function usageStats(usage) {
    if (!usage) return null;
    const v = usage.vendor || {};
    const r = usage.runtime || {};
    const input = v.inputTokens ?? 0;
    const output = v.outputTokens ?? 0;
    const cache = v.cacheReadInputTokens ?? 0;
    const reasoning = v.reasoningOutputTokens ?? 0;
    const total = input + output;
    return {
        input, output, cache, reasoning, total,
        context: r.totalContextTokens ?? null,
        hasData: total > 0 || cache > 0 || reasoning > 0,
    };
}

/** 工具调用参数 → 一行命令/参数展示（shell.run 取 command，其余取单值或 JSON）。 */
function formatToolArgs(toolName, args) {
    if (!args || Object.keys(args).length === 0) return '';
    if (toolName === 'shell.run' && typeof args.command === 'string') return args.command;
    const entries = Object.entries(args);
    if (entries.length === 1 && typeof entries[0][1] === 'string') return entries[0][1];
    return JSON.stringify(args);
}

/* ---- Step row conversion ---- */
function stepToRow(step, idx) {
    const durationMs = step.endedAt && step.startedAt ? step.endedAt - step.startedAt : null;
    return {
        key: 'step-' + step.stepId,
        stepId: step.stepId,
        goalId: step.goalId,
        taskId: step.taskId,
        at: step.startedAt,
        time: fmtTime(step.startedAt),
        kind: step.kind,
        kindLabel: kindLabel(step.kind),
        status: step.status,
        statusLabel: statusLabel(step.status),
        toolName: step.toolName || '',
        toolArgs: step.toolArguments || null,
        commandText: step.toolArguments ? formatToolArgs(step.toolName, step.toolArguments) : '',
        // 工具输出单独成体；intent 作为正文（intentText，不用代码框）；其余 kind 正文即 text
        text:
            step.kind === 'tool_call'
                ? step.toolOutput || ''
                : step.kind === 'intent'
                  ? ''
                  : step.content || step.payloadText || '',
        intentText: step.kind === 'intent' ? step.content || step.payloadText || '' : '',
        outputText: step.toolOutput || '',
        durationMs,
        duration: durationMs != null ? formatDuration(durationMs) : '',
        usage: step.usage || null,
    };
}

/* ---- Exec tree builders ---- */
/** Earliest step timestamp of a task; used to date the task header. */
function taskStartedAt(task) {
    let earliest = null;
    for (const step of task.steps || []) {
        if (step.startedAt && (earliest === null || step.startedAt < earliest)) {
            earliest = step.startedAt;
        }
    }
    return earliest;
}

/**
 * Task 内的展示行：thinking/工具调用各一行；**中间轮**的 intent 作为同轮 thinking 的正文
 * （intentText）内联展示，不单独成步。**整条 run 的最后一个 intent（最终模型输出）**
 * 不作为行，改由底部 Summary 区块独立展示（见 finalSummaryRowOf）。
 */
function taskStepRows(task, lastIntentId) {
    const steps = (task.steps || []).slice().sort((a, b) => a.startedAt - b.startedAt);
    const intentByRound = new Map();
    for (const s of steps) {
        const rid = s.usage?.roundId;
        // 最终输出不参与内联配对
        if (s.kind === 'intent' && rid && s.stepId !== lastIntentId) intentByRound.set(rid, s);
    }
    const rows = [];
    // 旧数据（无 roundId）回退：intent 紧邻前一个 thinking 时视为同轮。
    let lastThinking = null;
    for (const s of steps) {
        if (s.kind === 'observation') continue;
        if (s.kind === 'intent') {
            if (s.stepId === lastIntentId) continue; // 最终输出由底部 Summary 展示
            const rid = s.usage?.roundId;
            const paired =
                rid && steps.some((o) => o.kind === 'thinking' && o.usage?.roundId === rid);
            if (paired) continue; // 已在对应 thinking 行内联展示
            if (!rid && lastThinking && !lastThinking.intentText) {
                lastThinking.intentText = s.content || s.payloadText || '';
                continue;
            }
            rows.push(stepToRow(s, rows.length));
            continue;
        }
        const row = stepToRow(s, rows.length);
        if (s.kind === 'thinking') {
            if (s.usage?.roundId) {
                const intent = intentByRound.get(s.usage.roundId);
                if (intent) row.intentText = intent.content || intent.payloadText || '';
            }
            lastThinking = row;
        } else {
            lastThinking = null;
        }
        rows.push(row);
    }
    return rows;
}

/** 整条 run 的最后一个 intent（最终模型输出）stepId；由底部 Summary 展示。 */
function lastIntentStepId(detailObj) {
    let last = null;
    for (const goal of detailObj?.goals || []) {
        for (const task of goal.tasks || []) {
            for (const step of task.steps || []) {
                if (
                    step.kind === 'intent' &&
                    (last === null || step.startedAt >= last.startedAt)
                ) {
                    last = step;
                }
            }
        }
    }
    return last ? last.stepId : null;
}

/** 最终模型输出行（底部 Summary 区块：文本 + 该轮 usage）。 */
function finalSummaryRowOf(detailObj) {
    const intents = allStepsOf(detailObj).filter((r) => r.kind === 'intent');
    return intents.length > 0 ? intents[intents.length - 1] : null;
}

/**
 * Display tree. Goals without tasks (the internal intake goal) are dropped, and
 * each task carries one full date/time so its steps only show time-of-day.
 */
function buildExecTree(detailObj) {
    const lastIntentId = lastIntentStepId(detailObj);
    const goals = detailObj?.goals || [];
    return goals
        .filter((goal) => (goal.tasks || []).length > 0)
        .map((goal) => ({
            goalId: goal.goalId,
            statement: goal.statement,
            status: goal.status,
            tasks: (goal.tasks || []).map((task) => {
                const startedAt = taskStartedAt(task);
                return {
                    taskId: task.taskId,
                    title: task.title,
                    status: task.status,
                    time: startedAt ? fmtDateTime(startedAt) : '',
                    steps: taskStepRows(task, lastIntentId),
                };
            }),
        }));
}
function allStepsOf(detailObj) {
    const goals = detailObj?.goals || [];
    return goals.flatMap((g) => (g.tasks || []).flatMap((t) => (t.steps || []).map((s, i) => stepToRow(s, i))));
}
function buildExecStats(detailObj) {
    const rows = allStepsOf(detailObj);
    let inputTokens = 0;
    let outputTokens = 0;
    let totalMs = 0;
    // 同轮 usage 会挂 thinking + intent 两处，按 roundId 去重后求和
    const seenRounds = new Set();
    for (const r of rows) {
        const u = usageStats(r.usage);
        if (u) {
            const roundId = r.usage?.roundId;
            if (!roundId || !seenRounds.has(roundId)) {
                if (roundId) seenRounds.add(roundId);
                inputTokens += u.input || 0;
                outputTokens += u.output || 0;
            }
        }
        if (r.durationMs) totalMs += r.durationMs;
    }
    const tree = buildExecTree(detailObj);
    const taskCount = tree.reduce((s, g) => s + g.tasks.length, 0);
    const stepCount = rows.filter((r) => r.kind !== 'intent' && r.kind !== 'observation').length;
    return { inputTokens, outputTokens, totalTime: formatDuration(totalMs), taskCount, stepCount };
}


/* ---- Collapse state ---- */
const collapsedGoals = ref(new Set());
const collapsedTasks = ref(new Set());
const collapsedSteps = ref(new Set());
function toggleGoal(goalId) {
    const s = new Set(collapsedGoals.value);
    s.has(goalId) ? s.delete(goalId) : s.add(goalId);
    collapsedGoals.value = s;
}
function toggleTask(taskId) {
    const s = new Set(collapsedTasks.value);
    s.has(taskId) ? s.delete(taskId) : s.add(taskId);
    collapsedTasks.value = s;
}
function toggleStepCollapse(key) {
    const s = new Set(collapsedSteps.value);
    s.has(key) ? s.delete(key) : s.add(key);
    collapsedSteps.value = s;
}

/* ---- Step helpers ---- */
function isStepLong(row) {
    if (!row.text) return false;
    if (row.kind === 'intent') return false;
    // 工具调用始终可展开查看完整输出（命令/参数在标题行展示）
    if (row.kind === 'tool_call') return true;
    return row.text.length > 80 || row.text.includes('\n');
}
function stepTitleSummary(row) {
    const isError = row.status === 'error' || row.status === 'failed';
    if (isError) {
        return row.text ? `Error: ${row.text.slice(0, 80)}` : '执行失败';
    }
    return row.text ? row.text.slice(0, 80) : '';
}

/* ---- Derived view state (computed once per render pass) ---- */
const tree = computed(() => buildExecTree(props.runDetail));
const summary = computed(() => finalSummaryRowOf(props.runDetail));
const stats = computed(() => buildExecStats(props.runDetail));
</script>

<template>
    <!-- Live, append-only step list while the run executes: rows are only ever
         appended or updated in place, so the layout stays stable. -->
    <div v-if="busy && liveSteps.length" class="exec-stream">
        <div
            v-for="(step, i) in liveSteps"
            :key="step.stepId"
            class="exec-step"
            :class="[`exec-${step.kind}`, { error: step.status === 'error' || step.status === 'failed', selected: step.stepId === selectedStepId }]"
            @click="emit('select-step', { stepId: step.stepId, taskId: step.taskId })"
        >
            <div class="exec-step-head">
                <span v-if="step.status === 'running'" class="exec-spinner"></span>
                <LineIcon v-else :name="step.kind === 'thinking' ? 'lightbulb' : 'hammer'" size="16" />
                <span class="exec-step-tag">S#{{ i + 1 }}</span>
                <span class="exec-step-name">{{ step.toolName || step.kind }}</span>
                <span class="exec-step-summary">{{ step.title || '执行中…' }}</span>
                <span class="exec-step-time">{{ fmtTime(step.startedAt) }}</span>
            </div>
        </div>
    </div>
    <div v-else-if="runDetail" class="exec-stream">
        <!-- Goal → task → step. A single goal hides its own header so the user
             input is not repeated above the task title. -->
        <div
            v-for="(goal, gIdx) in tree"
            :key="goal.goalId"
            class="exec-goal"
            :class="{ single: tree.length === 1 }"
        >
            <div v-if="tree.length > 1" class="exec-goal-head" @click="toggleGoal(goal.goalId)">
                <span class="exec-dot goal-dot" :class="{ collapsed: collapsedGoals.has(goal.goalId) }"></span>
                <span class="exec-goal-tag">G#{{ gIdx + 1 }}</span>
                <span class="exec-goal-title">{{ goal.statement }}</span>
                <span class="exec-goal-count">{{ goal.tasks.length }} tasks · {{ goal.tasks.reduce((s, t) => s + t.steps.length, 0) }} steps</span>
            </div>
            <div v-if="!collapsedGoals.has(goal.goalId)" class="exec-goal-body">
                <div v-for="(task, tIdx) in goal.tasks" :key="task.taskId" class="exec-task">
                    <div
                        class="exec-task-head"
                        :data-task-id="task.taskId"
                        :class="{ selected: task.taskId === selectedTaskId }"
                        title="单击查看审计 · 双击折叠/展开"
                        @click="emit('select-task', task.taskId)"
                        @dblclick="toggleTask(task.taskId)"
                    >
                        <span
                            class="exec-dot task-dot interactive"
                            :class="{ collapsed: collapsedTasks.has(task.taskId) }"
                            @click.stop="toggleTask(task.taskId)"
                        ></span>
                        <span class="exec-task-tag">T#{{ tIdx + 1 }}</span>
                        <span class="exec-task-title">{{ task.title }}</span>
                        <span class="exec-task-count">{{ task.steps.length }} steps</span>
                        <span v-if="task.time" class="exec-task-time">{{ task.time }}</span>
                    </div>
                    <div v-if="!collapsedTasks.has(task.taskId)" class="exec-task-body">
                        <div
                            v-for="(row, sIdx) in task.steps"
                            :key="row.key"
                            class="exec-step"
                            :class="[`exec-${row.kind}`, { error: row.status === 'error' || row.status === 'failed' }]"
                        >
                            <div
                                class="exec-step-head"
                                :data-step-id="row.stepId"
                                :class="{ selected: row.stepId === selectedStepId }"
                                title="单击查看审计 · 双击折叠/展开"
                                @click="emit('select-step', { stepId: row.stepId, taskId: row.taskId })"
                                @dblclick="toggleStepCollapse(row.key)"
                            >
                                <button
                                    v-if="isStepLong(row)"
                                    class="exec-step-toggle"
                                    :class="{ collapsed: collapsedSteps.has(row.key) }"
                                    :title="collapsedSteps.has(row.key) ? '展开' : '折叠'"
                                    @click.stop="toggleStepCollapse(row.key)"
                                >
                                    <LineIcon
                                        class="kind-icon"
                                        :name="row.kind === 'thinking' ? 'lightbulb' : 'hammer'"
                                        size="16"
                                    />
                                    <span class="toggle-mark">{{ collapsedSteps.has(row.key) ? '+' : '−' }}</span>
                                </button>
                                <LineIcon
                                    v-else
                                    :name="row.kind === 'thinking' ? 'lightbulb' : 'hammer'"
                                    size="16"
                                />
                                <span class="exec-step-tag">S#{{ sIdx + 1 }}</span>
                                <span class="exec-step-name">{{ row.toolName || row.kind }}</span>
                                <span
                                    class="exec-step-summary"
                                    :title="row.toolArgs ? JSON.stringify(row.toolArgs) : undefined"
                                >{{ row.kind === 'tool_call' ? row.commandText : stepTitleSummary(row) }}</span>
                                <span
                                    v-if="row.status === 'error' || row.status === 'failed'"
                                    class="exec-step-status"
                                >失败</span>
                                <span v-if="row.duration" class="exec-step-duration">{{ row.duration }}</span>
                                <span class="exec-step-time">{{ row.time }}</span>
                            </div>
                            <div v-if="isStepLong(row) && !collapsedSteps.has(row.key) && row.text" class="exec-step-code">
                                <pre class="exec-step-code-inner">{{ row.text }}</pre>
                            </div>
                            <!-- 同轮 intent（模型输出）：紧贴 reasoning 下方，正文呈现（非代码框） -->
                            <div
                                v-if="row.intentText"
                                class="exec-intent-inline markdown-body"
                                v-html="renderMarkdown(row.intentText)"
                            ></div>
                            <div v-if="usageStats(row.usage)?.hasData" class="exec-step-usage">
                                {{ usageStats(row.usage).total }} tokens
                                <template v-if="usageStats(row.usage).cache"> · cache {{ usageStats(row.usage).cache }}</template>
                                <template v-if="usageStats(row.usage).reasoning"> · reasoning {{ usageStats(row.usage).reasoning }}</template>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 最终模型输出：独立 Summary（与最后一步 thinking 同轮，审计数据相同） -->
        <div
            v-if="summary"
            class="exec-summary"
            :class="{ selected: selectedStepId === summary.stepId }"
            @click="emit('select-step', { stepId: summary.stepId, taskId: summary.taskId })"
        >
            <div class="exec-summary-text markdown-body" v-html="renderMarkdown(summary.intentText)"></div>
            <div v-if="usageStats(summary.usage)?.hasData" class="exec-step-usage">
                {{ usageStats(summary.usage).total }} tokens
                <template v-if="usageStats(summary.usage).cache"> · cache {{ usageStats(summary.usage).cache }}</template>
                <template v-if="usageStats(summary.usage).reasoning"> · reasoning {{ usageStats(summary.usage).reasoning }}</template>
            </div>
        </div>

        <!-- Per-run stats + feedback -->
        <div class="exec-stats">
            <div class="exec-stats-fb">
                <button class="fb-btn" title="点赞"><LineIcon name="like" size="13" /></button>
                <button class="fb-btn" title="踩"><LineIcon name="dislike" size="13" /></button>
            </div>
            <span>{{ stats.stepCount }} steps</span>
            <span>·</span>
            <span>{{ stats.taskCount }} tasks</span>
            <span>·</span>
            <span>{{ stats.totalTime }}</span>
            <span>·</span>
            <span>{{ stats.inputTokens }} in / {{ stats.outputTokens }} out tokens</span>
        </div>
    </div>
    <div v-else-if="!busy" class="empty-hint">暂无执行步骤</div>
    <!-- Live streaming answer (token by token); hidden once the settled tree takes over. -->
    <div
        v-if="busy && liveStream && (liveStream.text || liveStream.reasoning)"
        class="live-stream"
    >
        <div v-if="liveStream.reasoning" class="live-reasoning">{{ liveStream.reasoning }}</div>
        <div
            v-if="liveStream.text"
            class="live-text markdown-body"
            v-html="renderMarkdown(liveStream.text)"
        ></div>
        <span class="live-cursor">▍</span>
    </div>
</template>

<style scoped>
.exec-stream {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 4px 0;
}
.exec-goal {
    margin-bottom: 10px;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-goal-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px 5px 14px;
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
    user-select: none;
}
.exec-goal-head:hover {
    background: var(--bg-hover);
}
.exec-goal-tag {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 1px 5px;
    border-radius: 4px;
    flex-shrink: 0;
    width: 36px;
    text-align: center;
}
.exec-goal-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.exec-goal-count {
    font-size: 11px;
    color: var(--fg-tertiary);
    font-weight: 400;
    flex-shrink: 0;
}
.exec-goal-body {
    /* Indent the task level so the three timeline lines stay clearly separated. */
    padding-left: 22px;
}
/* A run with a single goal drops the goal chrome (line + indent) entirely. */
.exec-goal.single {
    border-left: none;
    margin-bottom: 4px;
}
.exec-goal.single > .exec-goal-body {
    padding-left: 0;
}
.exec-task {
    margin: 8px 0;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-task-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 14px;
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--fg-secondary);
    user-select: none;
}
.exec-task-head:hover {
    background: var(--bg-hover);
}
.exec-task-tag {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--thinking);
    background: var(--thinking-soft);
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    width: 32px;
    text-align: center;
}
.exec-task-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.exec-task-count {
    font-size: 11px;
    color: var(--fg-tertiary);
    flex-shrink: 0;
}
/* Full date/time, shown once per task so steps can stay time-of-day only. */
.exec-task-time {
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.exec-task-body {
    /* Same offset again for the step level. */
    padding-left: 22px;
}
/* ---------- Collapsible dot (default circle, hover → +/- button) ---------- */
.exec-dot {
    position: absolute;
    left: -5px;
    top: 50%;
    transform: translateY(-50%);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid var(--fg-tertiary);
    box-sizing: border-box;
    cursor: default;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: transparent;
    transition: all 0.12s ease;
    z-index: 2;
}
.exec-dot.interactive {
    cursor: pointer;
}
.exec-dot::after {
    content: '−';
}
.exec-dot.collapsed::after {
    content: '+';
}
.goal-dot { border-color: var(--accent); }
.task-dot { border-color: var(--thinking); }
.exec-goal-head:hover .exec-dot,
.exec-task-head:hover .exec-dot {
    width: 16px;
    height: 16px;
    left: -9px;
    border-radius: 4px;
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
}
.exec-task-head:hover .exec-dot {
    background: var(--thinking);
    border-color: var(--thinking);
}
.exec-step {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 2px 0;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-step-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px 0 14px;
    height: 22px; /* 4px visual pad + 14px icon + 4px visual pad */
    box-sizing: border-box;
    font-size: 13px;
    line-height: 1;
    color: var(--fg-secondary);
    border-radius: var(--radius-sm);
}
.exec-step-head > * {
    margin-top: 0;
    margin-bottom: 0;
}
.exec-step-head .line-icon {
    display: block;
    flex-shrink: 0;
    color: var(--fg-tertiary);
    /* 竖线只在节点之间连接：图标带背景遮罩，遮住穿过的线 */
    box-sizing: content-box;
    padding: 2px;
    border-radius: 50%;
    background: var(--bg);
    margin-left: -23px; /* pull icon center onto the vertical timeline line */
}
.exec-step-head:hover .line-icon {
    background: var(--bg-hover);
}
.exec-step-head.selected .line-icon {
    background: var(--accent-soft);
}
.exec-step-head:hover {
    background: var(--bg-hover);
}
.exec-task-head.selected,
.exec-step-head.selected {
    background: var(--accent-soft);
    border-radius: var(--radius-sm);
}
.exec-step-head.selected .exec-step-name,
.exec-task-head.selected .exec-task-title {
    color: var(--accent-text);
}
/* 可折叠 step：hover 标题行时左侧图标变折叠按钮（圆角方块，与 task dot 一致；
   鼠标移开恢复为 kind 图标） */
.exec-step-toggle {
    display: inline-grid;
    place-items: center;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    padding: 0;
    margin-left: -21px;
    border: none;
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg-tertiary);
    cursor: pointer;
    flex-shrink: 0;
}
.exec-step-toggle .line-icon {
    margin-left: 0;
    padding: 0;
    background: transparent;
    box-sizing: border-box;
}
.exec-step-head:hover .exec-step-toggle .line-icon {
    background: transparent;
}
.exec-step-toggle .toggle-mark {
    display: none;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
}
.exec-step-head:hover .exec-step-toggle .kind-icon {
    display: none;
}
.exec-step-head:hover .exec-step-toggle .toggle-mark {
    display: block;
    color: #fff;
}
.exec-step-head.selected .exec-step-toggle {
    background: var(--accent-soft);
}
/* hover 时按 step 类型着色（与 task dot 的圆角方块一致） */
.exec-thinking .exec-step-head:hover .exec-step-toggle {
    background: var(--thinking);
}
.exec-tool_call .exec-step-head:hover .exec-step-toggle {
    background: var(--tool);
}
.exec-observation .exec-step-head:hover .exec-step-toggle {
    background: var(--observation);
}
.exec-step.error .exec-step-head:hover .exec-step-toggle {
    background: var(--error);
}
.exec-thinking .exec-step-head .line-icon { color: var(--thinking); }
.exec-tool_call .exec-step-head .line-icon { color: var(--tool); }
.exec-observation .exec-step-head .line-icon { color: var(--observation); }
.exec-step.error .exec-step-head .line-icon { color: var(--error); }

.exec-step-name {
    font-weight: 600;
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--fg);
    flex-shrink: 0;
}
.exec-step-tag {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    font-weight: 700;
    color: var(--fg-tertiary);
    background: var(--bg-code);
    padding: 1px 4px;
    border-radius: 3px;
    flex-shrink: 0;
    width: 36px;
    text-align: center;
}
.exec-thinking .exec-step-name { color: var(--thinking); }
.exec-intent .exec-step-name { color: var(--fg); }
.exec-tool_call .exec-step-name { color: var(--tool); }
.exec-observation .exec-step-name { color: var(--observation); }
.exec-step.error .exec-step-name { color: var(--error); }
.exec-intent .exec-step-head .line-icon { color: var(--fg); }
.exec-step-intent-text {
    margin: 2px 8px 4px 14px;
    padding: 0;
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 80%;
}
.exec-step-summary {
    font-size: 13px;
    color: var(--fg-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 80%;
    flex: 1 1 auto;
    min-width: 0;
}
.exec-step.error .exec-step-summary {
    color: var(--error);
}
.exec-step-status {
    flex: none;
    font-size: 11px;
    color: var(--danger, #ef4444);
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 4px;
}
.exec-step-duration {
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.exec-step-time {
    margin-left: auto;
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    flex-shrink: 0;
}
.exec-step-code {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin: 2px 8px 4px 14px;
    overflow: hidden;
}
.exec-step-code-inner {
    margin: 0;
    padding: 8px 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: calc(13px * 1.5 * 12 + 16px); /* 12 rows + padding */
    overflow: auto;
}
/* 同轮 intent（模型输出）：紧跟 reasoning 下方，正文非代码框，颜色比 thinking 的灰更深 */
.exec-intent-inline {
    margin: 2px 8px 6px 14px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg);
    word-break: break-word;
}
.exec-thinking .exec-step-code-inner {
    color: var(--fg-secondary);
    font-style: italic;
}
.exec-step.error .exec-step-code-inner {
    color: var(--error);
}
.exec-step-usage {
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    margin: 0 8px 2px 14px;
}
/* Spinner shown on the step currently executing (append-only live list). */
.exec-spinner {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    background: var(--bg); /* 遮罩：竖线不穿过转圈 */
    animation: exec-spin 0.7s linear infinite;
    margin-left: -20px; /* align with the timeline line, replacing the icon */
}
@keyframes exec-spin {
    to {
        transform: rotate(360deg);
    }
}

/* step dot: fully independent class, no .exec-dot inheritance */
.step-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--fg-tertiary);
    background: var(--bg);
    box-sizing: border-box;
    flex-shrink: 0;
    margin-left: -19px;
    cursor: default;
    position: relative;
}
.step-dot.interactive { cursor: pointer; }
.step-dot::after {
    content: '−';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 10px;
    font-weight: 700;
    color: transparent;
    line-height: 1;
}
.step-dot.collapsed::after { content: '+'; }
.exec-step.exec-thinking .step-dot { border-color: var(--thinking); }
.exec-step.exec-tool_call .step-dot { border-color: var(--tool); }
.exec-step.exec-observation .step-dot { border-color: var(--observation); }
.exec-step.error .step-dot { border-color: var(--error); }
.exec-step-head.clickable:hover .step-dot {
    width: 16px;
    height: 16px;
    margin-left: -23px;
    border-radius: 4px;
    background: var(--fg-tertiary);
    border-color: var(--fg-tertiary);
}
.exec-step-head.clickable:hover .step-dot::after { color: #fff; }
.exec-step.exec-thinking .exec-step-head.clickable:hover .step-dot { background: var(--thinking); border-color: var(--thinking); }
.exec-step.exec-tool_call .exec-step-head.clickable:hover .step-dot { background: var(--tool); border-color: var(--tool); }
.exec-step.exec-observation .exec-step-head.clickable:hover .step-dot { background: var(--observation); border-color: var(--observation); }
.exec-step.error .exec-step-head.clickable:hover .step-dot { background: var(--error); border-color: var(--error); }
.exec-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 4px 2px;
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}

/* Final summary (goal-level, sits after all goals/tasks/steps); click → audit */
.exec-summary {
    margin-top: 12px;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
}
.exec-summary:hover {
    background: var(--bg-hover, rgba(127, 127, 127, 0.08));
}
.exec-summary.selected {
    border-color: var(--accent, #6366f1);
}
.exec-summary-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg);
    word-break: break-word;
}
.exec-stats-fb {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-right: 4px;
}
/* Thumb up / down feedback buttons in the per-run stats row. */
.fb-btn {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--fg-tertiary);
    cursor: pointer;
    padding: 0;
}
.fb-btn:hover {
    background: var(--bg-hover);
    color: var(--accent);
}

/* ---------- Markdown-rendered model output ---------- */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
    margin: 1.1em 0 0.45em;
    line-height: 1.35;
    font-weight: 600;
    color: var(--fg);
}
.markdown-body :deep(h1) { font-size: 1.35em; }
.markdown-body :deep(h2) { font-size: 1.22em; }
.markdown-body :deep(h3) { font-size: 1.1em; }
.markdown-body :deep(h4) { font-size: 1em; }
.markdown-body :deep(h1:first-child),
.markdown-body :deep(h2:first-child),
.markdown-body :deep(h3:first-child),
.markdown-body :deep(p:first-child) {
    margin-top: 0;
}
.markdown-body :deep(p),
.markdown-body :deep(ul),
.markdown-body :deep(ol),
.markdown-body :deep(blockquote),
.markdown-body :deep(pre),
.markdown-body :deep(table) {
    margin: 0.5em 0;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
    padding-left: 1.5em;
}
.markdown-body :deep(li) {
    margin: 0.25em 0;
}
.markdown-body :deep(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--bg-code);
    border-radius: 4px;
    padding: 0.15em 0.4em;
    color: var(--fg);
}
.markdown-body :deep(pre) {
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    overflow-x: auto;
    line-height: 1.5;
}
.markdown-body :deep(pre code) {
    background: transparent;
    padding: 0;
    border-radius: 0;
    font-size: 13px;
    white-space: pre;
}
.markdown-body :deep(blockquote) {
    border-left: 3px solid var(--border);
    padding-left: 12px;
    color: var(--fg-secondary);
    margin-left: 0;
}
.markdown-body :deep(a) {
    color: var(--accent);
    text-decoration: none;
}
.markdown-body :deep(a:hover) {
    text-decoration: underline;
}
.markdown-body :deep(table) {
    border-collapse: collapse;
    font-size: 13px;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
    border: 1px solid var(--border);
    padding: 6px 10px;
}
.markdown-body :deep(th) {
    background: var(--bg-hover);
    font-weight: 600;
}
.markdown-body :deep(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1em 0;
}
.markdown-body :deep(img) {
    max-width: 100%;
    border-radius: 6px;
}

/* ---------- Live streaming answer ---------- */
.live-stream {
    margin: 8px 0 4px;
    padding: 0;
}
.live-reasoning {
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg-tertiary);
    white-space: pre-wrap;
    word-break: break-word;
    opacity: 0.85;
    margin-bottom: 8px;
}
.live-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg);
    word-break: break-word;
}
.live-cursor {
    display: inline-block;
    color: var(--accent);
    animation: live-blink 1s steps(2, start) infinite;
    margin-left: 1px;
}
@keyframes live-blink {
    to {
        visibility: hidden;
    }
}
</style>
