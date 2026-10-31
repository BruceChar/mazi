<script setup>
import { reactive, watch } from 'vue';

/**
 * 契约协商弹窗：triage 判定 negotiate / escalate 时弹出。
 * 承诺先摆出来（goal / 条款 / 默认路径 / 问题），用户答复后才修订并重新冻结契约。
 */
const props = defineProps({
    open: { type: Boolean, default: false },
    /** ContractTraceView（含 negotiation）；null = 无待协商项。 */
    entry: { type: Object, default: null },
    busy: { type: Boolean, default: false },
});
const emit = defineEmits(['submit', 'use-defaults', 'dismiss']);

/** 每问的答复草稿；打开或切换协商对象时清空（留空 = 采用该问自带的默认）。 */
const draft = reactive({});

watch(
    () => [props.open, props.entry?.goalId],
    () => {
        for (const key of Object.keys(draft)) delete draft[key];
        for (const question of props.entry?.negotiation?.questions ?? []) {
            draft[question.q] = '';
        }
    },
    { immediate: true },
);

const questions = () => props.entry?.negotiation?.questions ?? [];

function submit() {
    emit(
        'submit',
        questions().map((question) => ({
            q: question.q,
            answer: String(draft[question.q] ?? '').trim(),
        })),
    );
}

function useDefaults() {
    emit(
        'use-defaults',
        questions().map((question) => ({ q: question.q, answer: '', usedDefault: true })),
    );
}
</script>

<template>
    <div v-if="open && entry" class="modal-mask" @click.self="emit('dismiss')">
        <div class="modal negotiate-modal">
            <div class="negotiate-head">
                <h1>契约协商</h1>
                <span class="negotiate-route">{{
                    entry.negotiation.route === 'escalate' ? '升级待人决' : '需要澄清'
                }}</span>
            </div>
            <p class="negotiate-goal">{{ entry.statement }}</p>

            <div v-if="entry.negotiation.triggers.length" class="negotiate-triggers">
                <span v-for="trigger in entry.negotiation.triggers" :key="trigger" class="chip warn">
                    {{ trigger }}
                </span>
            </div>

            <div v-if="entry.negotiation.understanding?.length" class="negotiate-block">
                <div class="negotiate-label">理解</div>
                <ul>
                    <li v-for="item in entry.negotiation.understanding" :key="item">{{ item }}</li>
                </ul>
            </div>

            <div v-if="entry.negotiation.defaultPath?.length" class="negotiate-block">
                <div class="negotiate-label">不回复时走默认路径</div>
                <ul>
                    <li v-for="item in entry.negotiation.defaultPath" :key="item">{{ item }}</li>
                </ul>
            </div>

            <div v-if="entry.negotiation.escalation" class="negotiate-block escalation">
                <div class="negotiate-label">需要上级/责任方确认</div>
                <p>{{ entry.negotiation.escalation }}</p>
            </div>

            <div v-if="questions().length" class="negotiate-questions">
                <div v-for="question in questions()" :key="question.q" class="negotiate-question">
                    <label class="negotiate-q">{{ question.q }}</label>
                    <span v-if="question.why" class="negotiate-why">{{ question.why }}</span>
                    <textarea
                        v-model="draft[question.q]"
                        class="negotiate-input"
                        rows="2"
                        :placeholder="'留空采用默认：' + question.default"
                    ></textarea>
                </div>
            </div>

            <div class="negotiate-contract">
                <div class="negotiate-label">当前冻结条款（答复后追加为语义条款）</div>
                <ul class="negotiate-clauses">
                    <li v-for="condition in entry.conditions" :key="condition.id">
                        <span class="judge" :class="condition.judge">{{ condition.judgeLabel }}</span>
                        <span>{{ condition.text }}</span>
                    </li>
                </ul>
            </div>

            <div class="modal-actions">
                <button class="ghost" :disabled="busy" @click="emit('dismiss')">稍后再说</button>
                <button v-if="questions().length" class="ghost" :disabled="busy" @click="useDefaults">
                    全部采用默认
                </button>
                <button class="primary" :disabled="busy" @click="submit">
                    {{ busy ? '提交中…' : '冻结契约并继续' }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.modal-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 120;
}
.modal {
    background: var(--bg-panel);
    border-radius: 12px;
    padding: 22px 24px;
    width: 560px;
    max-width: 92vw;
    max-height: 86vh;
    overflow-y: auto;
    box-shadow: var(--shadow-lg);
}
.negotiate-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
}
.negotiate-head h1 {
    font-size: 18px;
    margin: 0;
}
.negotiate-route {
    font-size: 11px;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 4px;
    padding: 1px 6px;
}
.negotiate-goal {
    margin: 0 0 10px;
    font-size: 14px;
    color: var(--fg);
    line-height: 1.5;
}
.negotiate-triggers {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
}
.chip {
    font-size: 10px;
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    color: var(--fg-secondary);
}
.chip.warn {
    border-color: var(--warn);
    color: var(--warn);
}
.negotiate-block {
    margin-bottom: 10px;
}
.negotiate-block ul {
    margin: 4px 0 0;
    padding-left: 18px;
    color: var(--fg-secondary);
    font-size: 12px;
    line-height: 1.5;
}
.negotiate-block.escalation p {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--warn);
}
.negotiate-label {
    font-size: 11px;
    color: var(--fg-tertiary);
    text-transform: none;
}
.negotiate-questions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 12px 0;
}
.negotiate-question {
    display: flex;
    flex-direction: column;
    gap: 3px;
}
.negotiate-q {
    font-size: 13px;
    color: var(--fg);
}
.negotiate-why {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.negotiate-input {
    font-size: 12px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--fg);
    resize: vertical;
    font-family: inherit;
}
.negotiate-contract {
    margin-top: 8px;
}
.negotiate-clauses {
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.negotiate-clauses li {
    display: flex;
    gap: 6px;
    align-items: baseline;
}
.judge {
    flex-shrink: 0;
    font-size: 10px;
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    color: var(--fg-tertiary);
}
.judge.mechanical {
    border-color: var(--accent);
    color: var(--accent);
}
.judge.semantic {
    border-color: var(--warn);
    color: var(--warn);
}
.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
}
.modal-actions button {
    padding: 6px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
}
.modal-actions .primary {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
}
.modal-actions button:disabled {
    opacity: 0.5;
    cursor: default;
}
</style>
