import { describe, expect, it } from 'vitest';
import type { StepView } from '../src/types.js';
import { renderThinkingChain } from '../src/thinking-chain.js';

function step(over: Partial<StepView> & Pick<StepView, 'kind' | 'startedAt'>): StepView {
    return { stepId: over.stepId ?? 's', goalId: 'g', taskId: 't', status: 'succeeded', ...over };
}

describe('renderThinkingChain（thinking 链导出/评估）', () => {
    it('编号 thinking、附工具上下文、末轮 answer 单独成段', () => {
        const text = renderThinkingChain([
            step({
                stepId: 'd1',
                kind: 'deliberation',
                startedAt: 1,
                thinking: '用户输入了 ls，应该是想看目录。先列工作区。',
            }),
            step({
                stepId: 'i1',
                kind: 'invocation',
                startedAt: 2,
                toolName: 'shell.run',
                toolArguments: { command: 'ls' },
                toolOutput: '',
            }),
            step({
                stepId: 'd2',
                kind: 'deliberation',
                startedAt: 3,
                thinking: '输出为空，试试 eza 或 fd。',
            }),
            step({
                stepId: 'd3',
                kind: 'deliberation',
                startedAt: 4,
                thinking: '工作区是空的，路径 /tmp/ws。',
                answer: '要我在这里建个项目吗？',
            }),
        ]);
        expect(text).toBe(
            [
                '1. 用户输入了 ls，应该是想看目录。先列工作区。',
                '   ↳ shell.run {"command":"ls"} → (空)',
                '2. 输出为空，试试 eza 或 fd。',
                '3. 工作区是空的，路径 /tmp/ws。',
                '',
                '要我在这里建个项目吗？',
            ].join('\n'),
        );
    });

    it('includeTools=false 时省略工具行', () => {
        const text = renderThinkingChain(
            [
                step({ kind: 'deliberation', startedAt: 1, thinking: 't1' }),
                step({ kind: 'invocation', startedAt: 2, toolName: 'fs.read', toolOutput: 'data' }),
            ],
            { includeTools: false },
        );
        expect(text).toBe('1. t1');
    });

    it('无 thinking 的中间轮用 answer 占位，避免丢失旁白', () => {
        const text = renderThinkingChain([
            step({ kind: 'deliberation', startedAt: 1, answer: '我先读取文件。' }),
            step({ kind: 'deliberation', startedAt: 2, thinking: '读完了。', answer: '结论如下。' }),
        ]);
        expect(text).toBe(['1. 我先读取文件。', '2. 读完了。', '', '结论如下。'].join('\n'));
    });

    it('按 startedAt 排序；无步骤时返回空串', () => {
        const text = renderThinkingChain([
            step({ kind: 'deliberation', startedAt: 9, thinking: 'later' }),
            step({ kind: 'deliberation', startedAt: 1, thinking: 'earlier' }),
        ]);
        expect(text).toBe('1. earlier\n2. later');
        expect(renderThinkingChain([])).toBe('');
    });
});
