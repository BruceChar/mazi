import { describe, expect, it, vi } from 'vitest';
import { LazySlot } from '../src/harness/lazy.js';

class Resource {
    calls = 0;
    closed = 0;
    touch(): number {
        this.calls += 1;
        return this.calls;
    }
    close(): void {
        this.closed += 1;
    }
}

describe('LazySlot', () => {
    it('视图首次调用才 open，且只 open 一次', () => {
        const open = vi.fn(() => new Resource());
        const slot = new LazySlot(open);
        const view = slot.view();
        expect(open).not.toHaveBeenCalled();
        expect(view.touch()).toBe(1);
        expect(view.touch()).toBe(2);
        expect(open).toHaveBeenCalledTimes(1);
        expect(slot.isOpen()).toBe(true);
    });

    it('未打开的槽 close 不产生副作用；打开过的可幂等释放', () => {
        const resource = new Resource();
        const closedSlot = new LazySlot(() => resource);
        closedSlot.closeIfOpen();
        expect(resource.closed).toBe(0);

        const slot = new LazySlot(() => resource);
        slot.view().touch();
        slot.closeIfOpen();
        slot.closeIfOpen();
        expect(resource.closed).toBe(1);
    });
});
