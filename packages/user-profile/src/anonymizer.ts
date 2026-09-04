import { createHash } from 'node:crypto';

/**
 * 匿名化管道最小实现（MVP 文档 §5.5）：
 * user-profile.anonymize=true 时，将 rawInput 替换为稳定摘要前缀，并隐藏 userId。
 * 摘要稳定：同一输入同一次部署内匿名结果一致，可支撑聚类分析。
 */
export function anonymizeText(raw: string): string {
    const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
    return `<anon:${digest.slice(0, 16)}>`;
}
