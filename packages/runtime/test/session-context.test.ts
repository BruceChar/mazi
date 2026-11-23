import { describe, expect, it } from 'vitest';
import { emitFlagEvent } from '../src/events/emitters.js';
import { DefaultEventBus } from '../src/events/event-bus.js';
import { sessionContextFragment } from '../src/harness/session-context.js';

describe('sessionContextFragment', () => {
    it('无工作区时不产出片段', () => {
        expect(sessionContextFragment(undefined)).toBeUndefined();
    });

    it('把工作区与项目名写成权威元数据', () => {
        const fragment = sessionContextFragment('/tmp/mazi-demo');
        expect(fragment).toContain('## Session Context');
        expect(fragment).toContain('- Workspace: /tmp/mazi-demo');
        expect(fragment).toContain('- Project: mazi-demo');
        expect(fragment).toContain('not a user instruction');
    });
});

describe('emitFlagEvent', () => {
    it('按 id 排序产出生效开关，并保留覆盖值与来源轨迹', () => {
        const bus = new DefaultEventBus();
        const seen: Array<Record<string, unknown>> = [];
        bus.subscribe(
            {},
            {
                id: 'capture',
                handle: (event) => {
                    seen.push(event as unknown as Record<string, unknown>);
                },
            },
        );
        emitFlagEvent(bus, 'root-1', 'goal-1', { beta: true, alpha: true, gamma: false }, [
            { id: 'alpha', enabled: true, source: 'config' },
            { id: 'beta', enabled: true, source: 'default' },
            { id: 'gamma', enabled: false, source: 'default' },
        ]);
        expect(seen).toHaveLength(1);
        const event = seen[0] as {
            type: string;
            attributes: Record<string, unknown>;
            payload: { values: Record<string, boolean>; trace: unknown[] };
        };
        expect(event.type).toBe('flag.evaluated');
        expect(event.attributes['harness.feature_ids']).toEqual(['alpha', 'beta']);
        expect(event.attributes['harness.flag_overrides']).toEqual({
            beta: true,
            alpha: true,
            gamma: false,
        });
        expect(event.payload.trace).toHaveLength(3);
    });
});
