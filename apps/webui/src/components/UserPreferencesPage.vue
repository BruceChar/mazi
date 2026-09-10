<script setup>
/**
 * UserPreferencesPage — local profile preferences (name, tools, style).
 *
 * The values live in localStorage via the store; this component edits a local
 * copy and persists it on save so a cancelled edit never mutates global state.
 */
import { reactive } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import { saveUserPreferences, userPreferences } from '../scripts/store.js';

const emit = defineEmits(['close']);

/** Working copy — committed only when the user hits save. */
const preferences = reactive({ ...userPreferences });

function save() {
    saveUserPreferences(preferences);
    emit('close');
}
</script>

<template>
    <div class="page-card">
        <div class="page-heading">
            <button class="icon-btn back-btn" title="返回会话" @click="emit('close')">
                <LineIcon name="chevronRight" size="16" />
            </button>
            <h1>个人设置</h1>
        </div>
        <div class="field-row">
            <label>用户名</label>
            <input v-model="preferences.displayName" />
        </div>
        <div class="field-row">
            <label>常用工具 / 喜好</label>
            <input v-model="preferences.favoriteTools" placeholder="例如：Vue、TypeScript、终端工作流" />
        </div>
        <div class="field-row">
            <label>代码风格</label>
            <textarea v-model="preferences.codeStyle" rows="3" />
        </div>
        <div class="field-row">
            <label>模型回答风格</label>
            <textarea v-model="preferences.responseStyle" rows="3" />
        </div>
        <div class="page-actions">
            <button class="ghost" @click="emit('close')">取消</button>
            <button class="primary" @click="save">保存</button>
        </div>
    </div>
</template>
