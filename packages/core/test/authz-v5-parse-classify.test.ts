import { describe, expect, it } from 'vitest';

import { isHazard, type Op } from '../src/authz/v5/decision.js';
import { classifyTarget, type TargetFacts } from '../src/authz/v5/classify.js';
import { parseCommand, recheckTarget } from '../src/authz/v5/parser.js';

// ============================================================
// parser：复合命令拆链（§4 / D12）
// ============================================================

describe('parseCommand 拆链', () => {
    it('单命令 → 一个 op，可解析', () => {
        const result = parseCommand('pnpm test');
        expect(result.unparsed).toBe(false);
        expect(result.ops).toHaveLength(1);
    });

    it('内联解释器 sh -c 整条 unparsed（不可指纹化）', () => {
        const result = parseCommand('sh -c "rm -rf /"');
        expect(result.unparsed).toBe(true);
        expect(result.ops).toHaveLength(1);
    });

    it('python -c / eval 同样整条 unparsed', () => {
        expect(parseCommand('python -c "import os; os.system(\'ls\')"').unparsed).toBe(true);
        expect(parseCommand('eval "ls"').unparsed).toBe(true);
    });

    it('命令替换 $(...) 与反引号 → unparsed', () => {
        expect(parseCommand('echo $(whoami)').unparsed).toBe(true);
        expect(parseCommand('echo `whoami`').unparsed).toBe(true);
    });

    it('&& 串联 → 拆成两个 op（整链原子）', () => {
        const result = parseCommand('cd a && rm b');
        expect(result.unparsed).toBe(false);
        expect(result.ops).toHaveLength(2);
    });

    it('管道 → 链上两个 op，可解析', () => {
        const result = parseCommand('cat data.csv | curl -T /tmp/data.csv');
        expect(result.unparsed).toBe(false);
        expect(result.ops).toHaveLength(2);
    });
});

// ============================================================
// classifyTarget：对象七类（§4 表）
// ============================================================

function facts(over: Partial<TargetFacts> = {}): TargetFacts {
    return {
        path: 'src/app.ts',
        insideWorkspace: true,
        gitTracked: true,
        hasUncommittedChanges: false,
        gitignored: false,
        sensitive: false,
        critical: false,
        ...over,
    };
}

describe('classifyTarget 对象分类', () => {
    it('gitignore 命中 / 生成目录 → build_artifact / reversible', () => {
        const c = classifyTarget(facts({ path: 'dist/bundle.js', gitignored: true }));
        expect(c.object).toBe('build_artifact');
        expect(c.q1).toBe('reversible');
    });

    it('tracked 无未提交 → source / compensable', () => {
        const c = classifyTarget(facts());
        expect(c.object).toBe('source');
        expect(c.q1).toBe('compensable');
    });

    it('tracked 有未提交 → source_dirty / irreversible（hazard）', () => {
        const c = classifyTarget(facts({ hasUncommittedChanges: true }));
        expect(c.object).toBe('source_dirty');
        expect(c.q1).toBe('irreversible');
    });

    it('工作区外 → external（hazard：读/写/删/执行）', () => {
        const c = classifyTarget(facts({ path: '~/Documents/a.txt', insideWorkspace: false }));
        expect(c.object).toBe('external');
    });

    it('.git/ 等恢复能力区 → critical / irreversible', () => {
        const c = classifyTarget(facts({ path: '.git/HEAD', critical: true, gitTracked: false }));
        expect(c.object).toBe('critical');
        expect(c.q1).toBe('irreversible');
    });

    it('用户标记敏感区 → sensitive（读放行打污点）', () => {
        const c = classifyTarget(facts({ sensitive: true }));
        expect(c.object).toBe('sensitive');
    });

    it('分类器拿不准 → unknown / unproven（按 irreversible 对待）', () => {
        // 工作区内、未 tracked、未忽略：分类器拿不准。
        const c = classifyTarget(
            facts({ path: 'mysterious.bin', gitTracked: false, gitignored: false }),
        );
        expect(c.object).toBe('unknown');
        expect(c.q1).toBe('unproven');
    });
});

describe('envelope 能力边界（§13/D13）', () => {
    it('.husky / ci workflow / shell rc / authorized_keys → envelope', () => {
        expect(classifyTarget(facts({ path: '.husky/pre-commit' })).envelope).toBe(true);
        expect(classifyTarget(facts({ path: '.github/workflows/ci.yml' })).envelope).toBe(true);
        expect(classifyTarget(facts({ path: '~/.bashrc', insideWorkspace: false })).envelope).toBe(true);
        expect(classifyTarget(facts({ path: '~/.ssh/authorized_keys', insideWorkspace: false })).envelope).toBe(true);
    });

    it('普通源码 → envelope=false', () => {
        expect(classifyTarget(facts()).envelope).toBe(false);
    });
});

// ============================================================
// TOCTOU：批准到执行之间目标被换（§4）
// ============================================================

describe('recheckTarget 执行前重校验', () => {
    it('非 hazard 变 external/critical → 回 hazard，整链回弹窗', () => {
        const before: Op = {
            action: 'write',
            target: 'src/app.ts',
            object: 'source',
            data: 'clean',
            q1: 'compensable',
            envelope: false,
            originChain: false,
            targetFresh: false,
            channel: 'ui_user',
            attested: 'none',
            unparsed: false,
        };
        const after: Op = { ...before, target: '~/Documents/a.txt', object: 'external', q1: 'compensable' };
        expect(isHazard(before)).toBe(false);
        const result = recheckTarget(before, after);
        expect(result.hazardNow).toBe(true);
        expect(result.changed).toBe(true);
    });

    it('保持同类可补偿 → 不回弹', () => {
        const before: Op = {
            action: 'write',
            target: 'src/a.ts',
            object: 'source',
            data: 'clean',
            q1: 'compensable',
            envelope: false,
            originChain: false,
            targetFresh: false,
            channel: 'ui_user',
            attested: 'none',
            unparsed: false,
        };
        const after: Op = { ...before, target: 'src/b.ts' };
        expect(recheckTarget(before, after).changed).toBe(false);
    });
});
