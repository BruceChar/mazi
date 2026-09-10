<script setup>
/**
 * NewSessionModal — GoalContract quick-configuration dialog.
 *
 * Collects the goal statement, permission ceiling, budget, max steps, user id
 * and loop mode. The parent owns workspace resolution and the actual run
 * creation; this component only emits a normalized payload.
 */
import { ref, watch } from 'vue';
import {
    createGoalContractDraft,
    LOOP_MODES,
    PERMISSION_LEVELS,
    toGoalContractPayload,
} from '../scripts/goal-contract.ts';

const props = defineProps({
    /** Controls visibility; opening the dialog resets the draft. */
    open: { type: Boolean, default: false },
    /** Disables the "create & run" action while a run is in flight. */
    busy: { type: Boolean, default: false },
});
const emit = defineEmits(['close', 'submit']);

const draft = ref(createGoalContractDraft());

// Re-opening always starts from a clean contract so the previous goal never leaks.
watch(
    () => props.open,
    (open) => {
        if (open) draft.value = createGoalContractDraft();
    },
);

function submit(exec) {
    const statement = draft.value.statement.trim();
    if (!statement) return;
    emit('submit', {
        exec,
        goal: { statement, ...toGoalContractPayload(draft.value) },
    });
}
</script>

<template>
    <div v-if="open" class="modal-mask" @click.self="emit('close')">
        <div class="modal">
            <h1>新建会话 · GoalContract</h1>
            <div class="field-row">
                <label>任务</label>
                <textarea
                    v-model="draft.statement"
                    rows="3"
                    placeholder="目标陈述，例如：读取 README.md 并汇报"
                ></textarea>
            </div>
            <div class="grid2">
                <div class="field-row">
                    <label>权限上限</label>
                    <select v-model="draft.permission">
                        <option v-for="p in PERMISSION_LEVELS" :key="p" :value="p">{{ p }}</option>
                    </select>
                </div>
                <div class="field-row">
                    <label>预算（USD）</label>
                    <input v-model.number="draft.budgetUsd" type="number" step="0.1" />
                </div>
                <div class="field-row">
                    <label>最大步数</label>
                    <input v-model.number="draft.maxSteps" type="number" />
                </div>
                <div class="field-row">
                    <label>UserId（可选）</label>
                    <input v-model="draft.userId" placeholder="me" />
                </div>
                <div class="field-row">
                    <label>Loop 模式</label>
                    <select v-model="draft.loopMode">
                        <option v-for="m in LOOP_MODES" :key="m.value" :value="m.value">
                            {{ m.label }}
                        </option>
                    </select>
                </div>
            </div>
            <div class="modal-actions">
                <button class="ghost" @click="emit('close')">取消</button>
                <button @click="submit(false)">仅创建</button>
                <button class="primary" :disabled="busy" @click="submit(true)">创建并运行</button>
            </div>
        </div>
    </div>
</template>
