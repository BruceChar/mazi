import { describe, expect, it } from 'vitest';
import { QuestionService } from '../src/question/service.js';

describe('QuestionService', () => {
    it('未知问题不产出视图，list 默认为空', async () => {
        const service = new QuestionService();
        try {
            expect(await service.view('q-missing')).toBeUndefined();
            expect(await service.list()).toEqual([]);
            expect(await service.classify('q-missing')).toBe(false);
        } finally {
            service.close();
        }
    });

    it('无分类器时 classify 仍返回命中与否，不抛错', async () => {
        const service = new QuestionService();
        try {
            expect(await service.classify('q2')).toBe(false);
            expect(service.taxonomyView().version).toBeTruthy();
        } finally {
            service.close();
        }
    });
});
