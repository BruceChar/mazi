<script setup>
/**
 * UserPreferencesPage — local profile preferences (name, tools, style).
 *
 * The values live in localStorage via the store; this component edits a local
 * copy and persists it on save so a cancelled edit never mutates global state.
 */
import { reactive, ref } from 'vue';
import { saveUserPreferences, userPreferences } from '../scripts/store.js';

/** Working copy — committed only when the user hits save. */
const preferences = reactive({ ...userPreferences });
/** 保存后就地反馈（用户中心内不跳走）。 */
const saved = ref(false);
let savedTimer = null;

function save() {
    saveUserPreferences(preferences);
    saved.value = true;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
        saved.value = false;
    }, 1600);
}

/** 取消：把编辑副本还原为已存值，不离开当前 tab。 */
function reset() {
    Object.assign(preferences, userPreferences);
    saved.value = false;
}
</script>

<template>
    <div class="uc-panel">
        <div class="page-heading">
            <h1>用户设置</h1>
            <span v-if="saved" class="uc-saved">已保存</span>
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
            <button class="ghost" @click="reset">取消</button>
            <button class="primary" @click="save">保存</button>
        </div>
    </div>
</template>
