/**
 * 对话流末端 👍/👎 的评分映射（见 docs/用户行为流设计文档.md §10.5）。
 * 只有两档：点赞 5、踩 1；中间的 2-4 档留给显式评分（FeedbackModal）。
 */
export const VOTE_RATINGS = { up: 5, down: 1 } as const;

export type VoteKind = keyof typeof VOTE_RATINGS;

export function voteRating(kind: VoteKind): number {
    return VOTE_RATINGS[kind];
}
