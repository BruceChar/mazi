import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** 工作区 → 稳定项目标识（项目 wiki / 记忆作用域共用，不依赖任何存储）。 */
export function projectIdForWorkspace(workspace: string): string {
    return createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 16);
}
