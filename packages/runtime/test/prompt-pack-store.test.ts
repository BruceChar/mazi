import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROMPT_PACKS,
    PromptPackRegistry,
    SqlitePromptPackStore,
} from '../src/prompts/index.js';

function registry(dbPath: string): PromptPackRegistry {
    return new PromptPackRegistry(DEFAULT_PROMPT_PACKS, new SqlitePromptPackStore(dbPath));
}

describe('PromptPack persistence', () => {
    it('restores user overrides and keeps removed packs disabled across instances', () => {
        const dbPath = join(mkdtempSync(join(tmpdir(), 'mazi-prompt-store-')), 'mazi.db');
        const first = registry(dbPath);
        first.register({
            id: 'project-a',
            name: 'Project A',
            description: '项目 A 规则',
            version: 2,
            matcher: { projectIds: ['p-a'] },
            module: '遵循项目 A 的接口约定。',
        });
        first.close();

        const second = registry(dbPath);
        expect(second.list().find((pack) => pack.id === 'project-a')?.version).toBe(2);
        expect(second.remove('project-a')).toBe(true);
        second.close();

        const third = registry(dbPath);
        expect(third.list().some((pack) => pack.id === 'project-a')).toBe(false);
        third.close();
    });
});
