/**
 * 能力包测试用记录型事件总线：断言订阅残留、事件类型与属性，不做落盘。
 */

import type { EventFilter, EventSink, HarnessEvent, Unsubscribe } from '@mazi/core';
import { newHarnessEvent } from '../../src/events/event-bus.js';

export class RecordingBus {
    readonly events: HarnessEvent[] = [];
    private readonly subscribers = new Set<{ filter: EventFilter; sink: EventSink }>();

    readonly emit = (event: HarnessEvent): void => {
        this.events.push(event);
    };

    readonly subscribe = (filter: EventFilter, sink: EventSink): Unsubscribe => {
        const entry = { filter, sink };
        this.subscribers.add(entry);
        return () => {
            this.subscribers.delete(entry);
        };
    };

    get subscriberCount(): number {
        return this.subscribers.size;
    }

    /** 派发一条事件给匹配订阅者，返回触达的订阅数。 */
    dispatch(type: string): number {
        const event = newHarnessEvent({ type, rootGoalId: 'root' });
        let handled = 0;
        for (const { filter, sink } of [...this.subscribers]) {
            if (filter.types?.includes(type)) {
                sink.handle(event);
                handled += 1;
            }
        }
        return handled;
    }

    typesOf(): string[] {
        return this.events.map((event) => event.type);
    }
}
