<script setup>
/**
 * FeaturesPanel — 设置 → Features：特性开关（Feature）的列表 / 开关 / 新建 / 删除。
 *
 * Feature 是用户可编辑的声明式运行配置开关：开启后只做三件事——追加系统提示片段、
 * 调整 Skill 目录集合、收窄工具白名单；不注册工具、不放宽权限（docs/AB测试设计.md §3）。
 * 定义落 $MAZI_HOME/features.json；开关即时生效（运行期每次解析）。
 */
import { onMounted, reactive, ref } from 'vue';
import LineIcon from '../assets/LineIcon.vue';
import {
    createFeature,
    deleteFeature,
    features,
    featuresSummary,
    loadFeatures,
    updateFeature,
} from '../scripts/store.js';

const busy = ref('');
const message = ref('');
const error = ref('');
const createOpen = ref(false);
const creating = ref(false);
const form = reactive({
    id: '',
    name: '',
    description: '',
    promptFragment: '',
    skills: '',
    allowedTools: '',
    skillMode: 'add',
    reasoningLevel: '',
});

const REASONING_LEVELS = ['', 'off', 'low', 'medium', 'high'];

onMounted(loadFeatures);

function splitList(text) {
    return text
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

async function toggle(feature) {
    busy.value = feature.id;
    error.value = '';
    try {
        await updateFeature(feature.id, { enabled: !feature.enabled });
        message.value = (feature.enabled ? '已关闭 ' : '已开启 ') + feature.id;
    } catch (err) {
        error.value = String(err);
    } finally {
        busy.value = '';
    }
}

async function remove(feature) {
    if (!window.confirm('删除特性「' + feature.name + '」？该操作只影响后续运行。')) return;
    busy.value = feature.id;
    error.value = '';
    try {
        await deleteFeature(feature.id);
        message.value = '已删除 ' + feature.id;
    } catch (err) {
        error.value = String(err);
    } finally {
        busy.value = '';
    }
}

async function submit() {
    error.value = '';
    message.value = '';
    const id = form.id.trim();
    const name = form.name.trim();
    const description = form.description.trim();
    if (!id || !name || !description) {
        error.value = 'id / name / description 均为必填';
        return;
    }
    creating.value = true;
    try {
        await createFeature({
            id,
            name,
            description,
            enabled: false,
            ...(form.promptFragment.trim() ? { promptFragment: form.promptFragment.trim() } : {}),
            ...(splitList(form.skills).length > 0 ? { skills: splitList(form.skills) } : {}),
            ...(form.skills.trim() && form.skillMode === 'only' ? { skillMode: 'only' } : {}),
            ...(splitList(form.allowedTools).length > 0
                ? { allowedTools: splitList(form.allowedTools) }
                : {}),
            ...(form.reasoningLevel ? { reasoningLevel: form.reasoningLevel } : {}),
        });
        message.value = '已新建特性 ' + id;
        createOpen.value = false;
        form.id = '';
        form.name = '';
        form.description = '';
        form.promptFragment = '';
        form.skills = '';
        form.allowedTools = '';
        form.skillMode = 'add';
        form.reasoningLevel = '';
    } catch (err) {
        error.value = String(err);
    } finally {
        creating.value = false;
    }
}
</script>

<template>
    <div class="features-panel">
        <div class="head">
            <div>
                <div class="setting-name">Features（特性开关）</div>
                <div class="setting-desc">
                    {{ featuresSummary.total }} 项 · {{ featuresSummary.enabled }} 项开启 ·
                    定义存于 $MAZI_HOME/features.json，开关即时生效
                </div>
            </div>
            <button class="btn" @click="createOpen = !createOpen">
                <LineIcon name="plus" size="13" />{{ createOpen ? '收起' : '新建特性' }}
            </button>
        </div>

        <div v-if="error" class="notice error">{{ error }}</div>
        <div v-else-if="message" class="notice ok">{{ message }}</div>

        <div v-if="createOpen" class="create-card">
            <div class="grid">
                <label>id（kebab-case）<input v-model="form.id" placeholder="concise-answers" /></label>
                <label>名称<input v-model="form.name" placeholder="简洁作答" /></label>
            </div>
            <label class="full">描述（做什么 + 什么时候用）
                <input v-model="form.description" placeholder="要求模型先给结论，用于对照输出长度" />
            </label>
            <label class="full">系统提示片段（开启后追加）
                <textarea v-model="form.promptFragment" rows="3" placeholder="先给结论，再给理由；不超过三句话。" />
            </label>
            <div class="grid">
                <label>Skill id（逗号分隔）
                    <input v-model="form.skills" placeholder="success-diary, toc-analyze" />
                </label>
                <label>Skill 处理方式
                    <select v-model="form.skillMode">
                        <option value="add">叠加到已挂载</option>
                        <option value="only">仅这些（独占）</option>
                    </select>
                </label>
            </div>
            <div class="grid">
                <label>收窄工具（逗号分隔，留空不限）
                    <input v-model="form.allowedTools" placeholder="fs.read, rg" />
                </label>
                <label>默认推理强度
                    <select v-model="form.reasoningLevel">
                        <option v-for="level in REASONING_LEVELS" :key="level" :value="level">
                            {{ level || '（不指定）' }}
                        </option>
                    </select>
                </label>
            </div>
            <div class="actions">
                <button class="btn primary" :disabled="creating" @click="submit">
                    {{ creating ? '创建中…' : '创建' }}
                </button>
            </div>
        </div>

        <div v-if="!features.length" class="setting-empty">
            尚未定义特性。Feature 是「开关」：开启后追加提示片段 / 调整技能 / 收窄工具，
            用于在实验台对照验证增益。
        </div>
        <ul v-else class="feature-list">
            <li v-for="feature in features" :key="feature.id" :class="{ off: !feature.enabled }">
                <button
                    class="switch"
                    :class="{ on: feature.enabled }"
                    :disabled="busy === feature.id"
                    :title="feature.enabled ? '点击关闭' : '点击开启'"
                    @click="toggle(feature)"
                >
                    <span class="knob"></span>
                </button>
                <div class="body">
                    <div class="title-row">
                        <span class="setting-name">{{ feature.name }}</span>
                        <code>{{ feature.id }}</code>
                    </div>
                    <div class="setting-desc">{{ feature.description }}</div>
                    <div class="tags">
                        <span v-if="feature.promptFragment" class="setting-badge">提示片段</span>
                        <span v-if="feature.skills?.length" class="setting-badge">
                            Skill {{ feature.skillMode === 'only' ? '独占' : '叠加' }}：{{ feature.skills.join(', ') }}
                        </span>
                        <span v-if="feature.allowedTools?.length" class="setting-badge">
                            收窄工具：{{ feature.allowedTools.join(', ') }}
                        </span>
                        <span v-if="feature.reasoningLevel" class="setting-badge">
                            推理 {{ feature.reasoningLevel }}
                        </span>
                    </div>
                    <pre v-if="feature.promptFragment" class="fragment">{{ feature.promptFragment }}</pre>
                </div>
                <button class="icon-btn" title="删除" @click="remove(feature)">
                    <LineIcon name="trash" size="14" />
                </button>
            </li>
        </ul>
    </div>
</template>

<style scoped>
.features-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
.head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
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
.btn:disabled {
    opacity: 0.6;
    cursor: default;
}
.notice {
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
}
.notice.error {
    background: var(--error-soft);
    color: var(--error);
}
.notice.ok {
    background: var(--ok-soft);
    color: var(--ok);
}
.create-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-panel);
}
.grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
.create-card label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--fg-secondary);
}
.create-card input,
.create-card textarea,
.create-card select {
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--fg);
    font-size: 12px;
    font-family: inherit;
}
.actions {
    display: flex;
    justify-content: flex-end;
}
.feature-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.feature-list li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius);
    background: var(--bg-panel);
}
.feature-list li.off {
    opacity: 0.72;
}
.switch {
    flex: 0 0 auto;
    width: 30px;
    height: 18px;
    margin-top: 2px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--bg);
    position: relative;
    cursor: pointer;
    padding: 0;
}
.switch .knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--fg-tertiary);
    transition: left 0.12s ease, background 0.12s ease;
}
.switch.on {
    background: var(--accent-soft);
    border-color: var(--accent);
}
.switch.on .knob {
    left: 13px;
    background: var(--accent);
}
.body {
    flex: 1;
    min-width: 0;
}
.title-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
}
.title-row code {
    font-size: 11px;
    color: var(--fg-tertiary);
}
.tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 6px;
}
.fragment {
    margin: 6px 0 0;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-code, var(--bg));
    color: var(--fg-secondary);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
}
.icon-btn {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--fg-tertiary);
    border-radius: var(--radius-sm);
    cursor: pointer;
}
.icon-btn:hover {
    background: var(--error-soft);
    color: var(--error);
}
</style>
