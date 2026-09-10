<script setup>
import { ref } from 'vue';
import LineIcon from '../LineIcon.vue';

defineProps({
    runDetail: { type: Object, default: null },
    busy: { type: Boolean, default: false },
});

/* ---- Time formatting ---- */
function fmtClockMs(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    if (d.toDateString() === now.toDateString()) return time;
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${date} ${time}`;
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

/* ---- Step row conversion ---- */
function stepToRow(step, idx) {
    const durationMs = step.endedAt && step.startedAt ? step.endedAt - step.startedAt : null;
    return {
        key: 'step-' + step.stepId,
        stepId: step.stepId,
        goalId: step.goalId,
        taskId: step.taskId,
        at: step.startedAt,
        time: fmtClockMs(step.startedAt),
        kind: step.kind,
        kindLabel: kindLabel(step.kind),
        status: step.status,
        statusLabel: statusLabel(step.status),
        toolName: step.toolName || '',
        text: step.content || step.payloadText || '',
        durationMs,
        duration: durationMs != null ? formatDuration(durationMs) : '',
        usage: step.usage || null,
    };
}

/* ---- Exec tree builders ---- */
function buildExecTree(detailObj) {
    const goals = detailObj?.goals || [];
    return goals.map((goal) => ({
        goalId: goal.goalId,
        statement: goal.statement,
        status: goal.status,
        tasks: (goal.tasks || []).map((task) => ({
            taskId: task.taskId,
            title: task.title,
            status: task.status,
            steps: (task.steps || [])
                .filter((s) => s.kind !== 'intent' && s.kind !== 'observation')
                .map((s, i) => stepToRow(s, i)),
        })),
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
    for (const r of rows) {
        const u = usageStats(r.usage);
        if (u) {
            inputTokens += u.input || 0;
            outputTokens += u.output || 0;
        }
        if (r.durationMs) totalMs += r.durationMs;
    }
    const tree = buildExecTree(detailObj);
    const taskCount = tree.reduce((s, g) => s + g.tasks.length, 0);
    const stepCount = rows.filter((r) => r.kind !== 'intent' && r.kind !== 'observation').length;
    return { inputTokens, outputTokens, totalTime: formatDuration(totalMs), taskCount, stepCount };
}
function finalSummaryOf(detailObj) {
    const intentRows = allStepsOf(detailObj).filter((r) => r.kind === 'intent');
    if (intentRows.length > 0) return intentRows[intentRows.length - 1].text || '';
    return '';
}
function reasoningTextOf(detailObj) {
    const thinkingRows = allStepsOf(detailObj).filter((r) => r.kind === 'thinking');
    return thinkingRows.map((r) => r.text).filter(Boolean).join('\n\n');
}
function isSimpleExecOf(detailObj) {
    const tree = buildExecTree(detailObj);
    if (tree.length !== 1) return false;
    const tasks = tree[0].tasks;
    if (tasks.length !== 1) return false;
    return tasks[0].steps.length === 0;
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
    return row.text.length > 80 || row.text.includes('\n');
}
function stepTitleSummary(row) {
    const isError = row.status === 'error' || row.status === 'failed';
    if (isError) {
        return row.text ? `Error: ${row.text.slice(0, 80)}` : '执行失败';
    }
    return row.text ? row.text.slice(0, 80) : '';
}
</script>

<template>
    <div v-if="runDetail" class="exec-stream">
        <!-- Simple run (1 goal / 1 task / 0 steps): show output directly -->
        <template v-if="isSimpleExecOf(runDetail)">
            <div v-if="reasoningTextOf(runDetail)" class="exec-reasoning">{{ reasoningTextOf(runDetail) }}</div>
            <div v-if="finalSummaryOf(runDetail)" class="exec-summary">
                <div class="exec-summary-text">{{ finalSummaryOf(runDetail) }}</div>
            </div>
        </template>
        <!-- Normal run: goal → task → step hierarchy -->
        <template v-else>
            <div v-for="(goal, gIdx) in buildExecTree(runDetail)" :key="goal.goalId" class="exec-goal">
                <div class="exec-goal-head" @click="toggleGoal(goal.goalId)">
                    <span class="exec-dot goal-dot" :class="{ collapsed: collapsedGoals.has(goal.goalId) }"></span>
                    <span class="exec-goal-tag">G#{{ gIdx + 1 }}</span>
                    <span class="exec-goal-title">{{ goal.statement }}</span>
                    <span class="exec-goal-count">{{ goal.tasks.length }} tasks · {{ goal.tasks.reduce((s, t) => s + t.steps.length, 0) }} steps</span>
                </div>
                <div v-if="!collapsedGoals.has(goal.goalId)" class="exec-goal-body">
                    <div v-for="(task, tIdx) in goal.tasks" :key="task.taskId" class="exec-task">
                        <div class="exec-task-head" @click="toggleTask(task.taskId)">
                            <span class="exec-dot task-dot" :class="{ collapsed: collapsedTasks.has(task.taskId) }"></span>
                            <span class="exec-task-tag">T#{{ tIdx + 1 }}</span>
                            <span class="exec-task-title">{{ task.title }}</span>
                            <span class="exec-task-count">{{ task.steps.length }} steps</span>
                        </div>
                        <div v-if="!collapsedTasks.has(task.taskId)" class="exec-task-body">
                            <div
                                v-for="(row, sIdx) in task.steps"
                                :key="row.key"
                                class="exec-step"
                                :class="[`exec-${row.kind}`, { error: row.status === 'error' || row.status === 'failed' }]"
                            >
                                <div class="exec-step-head" :class="{ clickable: isStepLong(row) }" @click="isStepLong(row) && toggleStepCollapse(row.key)">
                                    <LineIcon :name="row.kind === 'thinking' ? 'lightbulb' : 'hammer'" size="16" />
                                    <span class="exec-step-tag">S#{{ sIdx + 1 }}</span>
                                    <span class="exec-step-name">{{ row.toolName || row.kind }}</span>
                                    <span class="exec-step-summary">{{ stepTitleSummary(row) }}</span>
                                    <span v-if="row.duration" class="exec-step-duration">{{ row.duration }}</span>
                                    <span class="exec-step-time">{{ row.time }}</span>
                                </div>
                                <div v-if="isStepLong(row) && !collapsedSteps.has(row.key) && row.text" class="exec-step-code">
                                    <pre class="exec-step-code-inner">{{ row.text }}</pre>
                                </div>
                                <div v-if="usageStats(row.usage)?.hasData" class="exec-step-usage">
                                    {{ usageStats(row.usage).total }} tokens
                                    <template v-if="usageStats(row.usage).cache"> · cache {{ usageStats(row.usage).cache }}</template>
                                </div>
                            </div>
                            <div v-if="!task.steps.length" class="empty-hint">（该 Task 尚无 Step）</div>
                        </div>
                    </div>
                </div>
            </div>
        </template>
        <!-- Final summary (goal-level, not a step) -->
        <div v-if="finalSummaryOf(runDetail) && !isSimpleExecOf(runDetail)" class="exec-summary">
            <div class="exec-summary-text">{{ finalSummaryOf(runDetail) }}</div>
        </div>
        <!-- Per-run stats + feedback -->
        <div class="exec-stats">
            <div class="exec-stats-fb">
                <button class="fb-btn" title="点赞"><LineIcon name="like" size="13" /></button>
                <button class="fb-btn" title="踩"><LineIcon name="dislike" size="13" /></button>
            </div>
            <span>{{ buildExecStats(runDetail).stepCount }} steps</span>
            <span>·</span>
            <span>{{ buildExecStats(runDetail).taskCount }} tasks</span>
            <span>·</span>
            <span>{{ buildExecStats(runDetail).totalTime }}</span>
            <span>·</span>
            <span>{{ buildExecStats(runDetail).inputTokens }} in / {{ buildExecStats(runDetail).outputTokens }} out tokens</span>
        </div>
    </div>
    <div v-else-if="!busy" class="empty-hint">暂无执行步骤</div>
</template>

<style scoped>
.exec-stream {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 4px 0;
}
.exec-goal {
    margin-bottom: 6px;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-goal-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 14px;
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
    padding-left: 14px;
}
.exec-task {
    margin: 4px 0;
    position: relative;
    border-left: 2px solid var(--border);
}
.exec-task-head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 14px;
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
.exec-task-body {
    padding-left: 14px;
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
    margin-left: -21px; /* pull icon center onto the vertical timeline line */
}
.exec-step-head.clickable {
    cursor: pointer;
}
.exec-step-head.clickable:hover {
    background: var(--bg-hover);
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
.exec-stats-fb {
    display: flex;
    align-items: center;
    gap: 4px;
}

/* Final summary (goal-level, sits after all goals/tasks/steps) */
.exec-summary {
    margin-top: 12px;
    padding: 0;
    border: none;
    background: transparent;
}
.exec-summary-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
}
.exec-reasoning {
    font-size: 13px;
    line-height: 1.6;
    color: var(--fg-secondary);
    font-style: italic;
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 12px;
    opacity: 0.8;
}
.exec-stats-fb {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-right: 4px;
}
</style>
