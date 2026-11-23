import type { PersonalMemoryService } from '../memory/personal-memory.js';
import type { RuntimePlugin } from './types.js';

/**
 * 记忆插件 —— 首个从宿主编译期装配中移出的能力。
 *
 * 只声明提供 memory 服务；真正的记忆策略（remember/recall/unionScope）
 * 仍由 PersonalMemoryService 承担，后续可在此挂 context.assemble 钩子。
 */
export function memoryPlugin(service: PersonalMemoryService): RuntimePlugin {
    return {
        manifest: {
            id: 'memory',
            version: '1.0.0',
            description: '长期记忆与个人记忆检索',
            provides: [{ name: 'memory', create: () => service }],
        },
        install: () => undefined,
    };
}
