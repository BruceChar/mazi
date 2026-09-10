<script setup>
import LineIcon from '../LineIcon.vue';
import ExecStream from './ExecStream.vue';
import Composer from './Composer.vue';

const props = defineProps({
    activeConversation: { type: Object, default: null },
    workspaceRoot: { type: String, default: '' },
    workspaceDisplayName: { type: String, default: '' },
    runs: { type: Array, default: () => [] },
    runDetails: { type: Object, default: () => ({}) },
    current: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    suggestionCards: { type: Array, default: () => [] },
    feedbackSent: { type: Boolean, default: false },
    prompt: { type: String, default: '' },
    projects: { type: Array, default: () => [] },
    cfg: { type: Object, default: null },
    selectedModel: { type: String, default: '' },
    reasoningLevel: { type: String, default: 'high' },
    reasoningLevels: { type: Array, default: () => [] },
    taskCount: { type: Number, default: 0 },
    stepCount: { type: Number, default: 0 },
});
const emit = defineEmits([
    'use-suggestion',
    'update:prompt',
    'submit',
    'switch-project',
    'open-system-picker',
    'exit-workspace',
    'update:selectedModel',
    'update:reasoningLevel',
]);

function conversationTitle(conversation) {
    return conversation?.title || conversation?.input || '';
}
function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
</script>

<template>
    <div class="chat-main">
        <div v-if="activeConversation" class="goal-conv-head">
            <span class="goal-conv-title">{{ conversationTitle(activeConversation) }}</span>
            <span v-if="workspaceRoot" class="goal-conv-ws">{{ workspaceRoot }}</span>
        </div>

        <div class="chat-scroll">
            <template v-if="activeConversation && runs.length">
                <div v-for="run in runs" :key="run.rootGoalId" class="run-block" :class="{ current: run.rootGoalId === current }">
                    <!-- User message -->
                    <div class="msg msg-user">
                        <div class="msg-bubble">{{ run.input }}</div>
                        <span class="msg-time">{{ fmtClock(run.createdAt) }}</span>
                    </div>
                    <!-- Executing indicator -->
                    <div v-if="run.rootGoalId === current && busy" class="msg msg-assistant">
                        <div class="msg-bubble thinking-bubble">执行中…</div>
                    </div>
                    <!-- Execution stream -->
                    <ExecStream
                        :run-detail="runDetails[run.rootGoalId]"
                        :busy="busy && run.rootGoalId === current"
                    />
                </div>
            </template>
            <div v-else-if="activeConversation" class="empty-hint">
                暂无 run，输入任务开始
            </div>
            <div v-else class="welcome-screen">
                <div class="welcome-icon">
                    <LineIcon name="userMessage" size="36" />
                </div>
                <h2 class="welcome-title">
                    What should we build{{ workspaceDisplayName ? ` in ${workspaceDisplayName}` : '' }}?
                </h2>
                <div class="welcome-cards">
                    <button
                        v-for="card in suggestionCards"
                        :key="card.title"
                        class="welcome-card"
                        @click="emit('use-suggestion', card)"
                    >
                        <span class="welcome-card-icon" :style="{ color: card.color }">
                            <LineIcon :name="card.icon" size="18" />
                        </span>
                        <span class="welcome-card-title">{{ card.title }}</span>
                    </button>
                </div>
            </div>
        </div>

        <div v-if="feedbackSent" class="ok-banner">反馈已记录</div>

        <Composer
            :model-value="prompt"
            :busy="busy"
            :active-conversation="activeConversation"
            :projects="projects"
            :workspace-root="workspaceRoot"
            :cfg="cfg"
            :selected-model="selectedModel"
            :reasoning-level="reasoningLevel"
            :reasoning-levels="reasoningLevels"
            @update:model-value="emit('update:prompt', $event)"
            @submit="emit('submit')"
            @switch-project="emit('switch-project', $event)"
            @open-system-picker="emit('open-system-picker')"
            @exit-workspace="emit('exit-workspace')"
            @update:selected-model="emit('update:selectedModel', $event)"
            @update:reasoning-level="emit('update:reasoningLevel', $event)"
        />
        <div class="statusbar">
            <span class="stat">{{ runs.length }} sessions</span>
            <span class="stat">{{ 0 }} goals</span>
            <span class="stat">{{ taskCount }} tasks</span>
            <span class="stat">{{ stepCount }} steps</span>
            <span class="stat">{{ 0 }} inputs</span>
            <span class="stat">{{ 0 }} outputs</span>
            <span class="stat">{{ 0 }} costs</span>
        </div>
    </div>
</template>

<style scoped>
.chat-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    background: var(--bg);
}
.goal-conv-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 10px 14px 2px;
    flex-wrap: wrap;
}
.goal-conv-title {
    font-weight: 600;
    font-size: 15px;
}
.goal-conv-ws {
    color: var(--fg-secondary);
    font-size: 12px;
}
.chat-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    min-height: 0;
}
.run-block {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 24px;
}
.run-block.current {
    opacity: 1;
}
.msg {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.msg-user {
    align-items: flex-end;
}
.msg-assistant {
    align-items: flex-start;
}
.msg-bubble {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.5;
    word-break: break-word;
}
.msg-user .msg-bubble {
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
}
.msg-assistant .msg-bubble {
    background: var(--bg-panel);
    color: var(--fg);
    border: 1px solid var(--border-soft);
    border-bottom-left-radius: 4px;
}
.thinking-bubble {
    color: var(--fg-secondary);
    font-style: italic;
}
.msg-time {
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
}
.empty-hint {
    color: var(--fg-tertiary);
    font-size: 13px;
    padding: 40px 0;
    text-align: center;
}
.welcome-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 20px;
    padding: 40px 20px;
}
.welcome-icon {
    color: var(--accent);
    opacity: 0.6;
}
.welcome-title {
    font-size: 24px;
    font-weight: 600;
    color: var(--fg);
    margin: 0;
    text-align: center;
}
.welcome-cards {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
    max-width: 600px;
}
.welcome-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 16px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-panel);
    cursor: pointer;
    transition: all 0.12s;
    min-width: 160px;
}
.welcome-card:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
    transform: translateY(-2px);
}
.welcome-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
}
.welcome-card-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg);
}
.ok-banner {
    padding: 8px 16px;
    background: rgba(34, 197, 94, 0.1);
    color: #22c55e;
    font-size: 13px;
    text-align: center;
}
.statusbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 16px 10px;
    font-size: 11px;
    color: var(--fg-tertiary);
    font-family: ui-monospace, monospace;
    max-width: 760px;
    margin: 0 auto;
    width: 100%;
}
.stat {
    white-space: nowrap;
}
</style>
