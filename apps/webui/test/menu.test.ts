import { describe, expect, it } from 'vitest';
import { computeMenuPlacement, MENU_FLIP_SPACE_PX, MENU_GAP_PX } from '../src/scripts/menu.ts';

describe('computeMenuPlacement', () => {
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
