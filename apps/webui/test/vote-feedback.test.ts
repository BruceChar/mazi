import { describe, expect, it } from 'vitest';
import { VOTE_RATINGS, voteRating } from '../src/scripts/vote-feedback.ts';

describe('vote-feedback（对话流 👍/👎 → 行为流 rating）', () => {
    it('点赞 5、踩 1，都在 1-5 区间内', () => {
        expect(voteRating('up')).toBe(5);
        expect(voteRating('down')).toBe(1);
        for (const rating of Object.values(VOTE_RATINGS)) {
            expect(rating).toBeGreaterThanOrEqual(1);
            expect(rating).toBeLessThanOrEqual(5);
        }
    });
});
