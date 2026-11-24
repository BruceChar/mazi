import { describe, expect, it } from 'vitest';
import {
    computeMenuPlacement,
    isAnchorOutOfView,
    MENU_FLIP_SPACE_PX,
    MENU_GAP_PX,
} from '../src/scripts/menu.ts';

describe('computeMenuPlacement', () => {
    it('keeps the menu flush so the pointer never crosses a dead gap', () => {
        expect(MENU_GAP_PX).toBe(0);
    });

    it('opens below the trigger when there is room', () => {
        const rect = { top: 100, bottom: 124, right: 200 };
        expect(computeMenuPlacement(rect, 800)).toEqual({
            top: rect.bottom + MENU_GAP_PX,
            left: 200,
            up: false,
        });
    });

    it('flips above the trigger when the viewport bottom is near', () => {
        const rect = { top: 700, bottom: 724, right: 200 };
        const placement = computeMenuPlacement(rect, 800);
        expect(placement.up).toBe(true);
        expect(placement.top).toBe(rect.top - MENU_GAP_PX);
        expect(placement.left).toBe(200);
    });

    it('uses the trigger right edge as the fixed left so the menu stays anchored', () => {
        expect(computeMenuPlacement({ top: 10, bottom: 34, right: 240 }, 900).left).toBe(240);
    });

    it('flips exactly when the remaining space is exhausted', () => {
        const viewportHeight = 800;
        const bottom = viewportHeight - MENU_FLIP_SPACE_PX;
        expect(computeMenuPlacement({ top: bottom - 24, bottom, right: 10 }, viewportHeight).up).toBe(
            false,
        );
        expect(
            computeMenuPlacement({ top: bottom - 23, bottom: bottom + 1, right: 10 }, viewportHeight)
                .up,
        ).toBe(true);
    });
});

describe('isAnchorOutOfView', () => {
    const container = { top: 200, bottom: 700 };

    it('keeps the menu while the trigger is still inside the list viewport', () => {
        expect(isAnchorOutOfView({ top: 640, bottom: 664 }, container)).toBe(false);
        expect(isAnchorOutOfView({ top: 200, bottom: 224 }, container)).toBe(false);
    });

    it('closes once the trigger scrolls fully above or below the list viewport', () => {
        expect(isAnchorOutOfView({ top: 152, bottom: 176 }, container)).toBe(true);
        expect(isAnchorOutOfView({ top: 700, bottom: 724 }, container)).toBe(true);
    });

    it('closes a trigger that only touches the edge, but keeps one that is still half inside', () => {
        expect(isAnchorOutOfView({ top: 176, bottom: 200 }, container)).toBe(true);
        expect(isAnchorOutOfView({ top: 640, bottom: 700 }, container)).toBe(false);
    });
});
