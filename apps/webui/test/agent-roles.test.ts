import { describe, expect, it } from 'vitest';
import {
    buildRolePayload,
    emptyRoleForm,
    roleModelLabel,
    roleModelOptions,
    roleSummary,
    roleToForm,
    validateRolePayload,
} from '../src/scripts/agent-roles.ts';

const cfg = {
    providers: [
        {
            id: 'deepseek',
            vendor: 'deepseek',
            models: [
                { id: 'deepseek-v4', modelVersion: 'DeepSeek V4' },
                { id: 'deepseek-mini', name: 'DeepSeek Mini' },
            ],
        },
        { id: 'empty', vendor: 'empty', models: [] },
    ],
};

describe('agent-roles（角色表单纯函数）', () => {
    it('新建草稿默认跟随会话默认模型', () => {
        const form = emptyRoleForm();
        expect(form.modelId).toBe('');
        expect(form.defaultCeiling).toBe('read-only');
        expect(buildRolePayload(form).modelId).toBeUndefined();
    });

    it('提交载荷归一化：去空白、工具拆分为数组、空可选字段不下发', () => {
        const payload = buildRolePayload({
            ...emptyRoleForm(),
            roleId: '  doc-writer ',
            label: ' 文档 Agent ',
            tools: 'fs.read, rg , , sd',
            systemPrompt: '   ',
        });
        expect(payload).toEqual({
            roleId: 'doc-writer',
            label: '文档 Agent',
            tools: ['fs.read', 'rg', 'sd'],
            defaultCeiling: 'read-only',
            memoryPolicy: 'inherit',
        });
    });

    it('显式指定模型时下发 modelId', () => {
        const payload = buildRolePayload({
            ...emptyRoleForm(),
            roleId: 'coding',
            label: '编码 Agent',
            modelId: 'deepseek-v4',
            description: ' 改代码、跑测试 ',
        });
        expect(payload.modelId).toBe('deepseek-v4');
        expect(payload.description).toBe('改代码、跑测试');
    });

    it('校验：ID 必填、slug 格式、名称必填', () => {
        const base = buildRolePayload(emptyRoleForm());
        expect(validateRolePayload(base)).toBe('角色 ID 必填');
        expect(validateRolePayload({ ...base, roleId: 'Agent_X' })).toBe(
            '角色 ID 只能用小写字母、数字和连字符',
        );
        expect(validateRolePayload({ ...base, roleId: 'doc', label: '' })).toBe('显示名称必填');
        expect(validateRolePayload({ ...base, roleId: 'doc', label: '文档' })).toBe('');
    });

    it('模型选项带 provider 分组，空 provider 不产生选项', () => {
        const options = roleModelOptions(cfg);
        expect(options.map((option) => option.value)).toEqual(['deepseek-v4', 'deepseek-mini']);
        expect(options.map((option) => option.group)).toEqual(['deepseek', 'deepseek']);
        expect(roleModelOptions(null)).toEqual([]);
    });

    it('模型展示：未指定显示「跟随会话默认」，未知 id 原样展示', () => {
        expect(roleModelLabel(cfg, undefined)).toBe('跟随会话默认');
        expect(roleModelLabel(cfg, 'deepseek-v4')).toBe('DeepSeek V4');
        expect(roleModelLabel(cfg, 'unknown')).toBe('unknown');
    });

    it('卡片摘要优先 description，缺失时回退权限与工具数', () => {
        expect(roleSummary({ description: '调查与证据归纳' })).toBe('调查与证据归纳');
        expect(roleSummary({ defaultCeiling: 'read-only', tools: ['fs.read', 'rg'] })).toBe(
            'read-only · 2 个工具',
        );
    });

    it('已存在角色可回读为草稿（工具用逗号连接）', () => {
        const form = roleToForm({
            roleId: 'coding',
            label: '编码 Agent',
            modelId: 'deepseek-v4',
            tools: ['fs.read', 'rg'],
            memoryPolicy: 'isolated',
        });
        expect(form.tools).toBe('fs.read, rg');
        expect(form.memoryPolicy).toBe('isolated');
        expect(form.modelId).toBe('deepseek-v4');
    });
});
