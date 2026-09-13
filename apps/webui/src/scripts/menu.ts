/** Viewport-fixed placement of the sidebar "..." menu. */

export interface MenuTriggerRect {
    top: number;
    bottom: number;
    right: number;
}

export interface MenuPlacement {
    /** Fixed top, in viewport pixels. */
    top: number;
    /** Fixed left, in viewport pixels (the trigger's right edge). */
    left: number;
    /** True when the menu is flipped above the trigger. */
    up: boolean;
}

/** Space kept below the trigger before the menu flips above it. */
export const MENU_FLIP_SPACE_PX = 140;
/** Gap between the trigger and the menu. */
export const MENU_GAP_PX = 6;

/**
 * Compute the position for the floating menu.
 *
 * The menu is teleported to <body> so that `position: fixed` is resolved
 * against the viewport even while the responsive sidebar carries a transform
 * (a transformed ancestor would otherwise become its containing block and
 * push the menu off-screen). Because of that, both `rect` and
 * `viewportHeight` are viewport coordinates and the result can be applied
 * directly as `position: fixed; top/left`.
 */
export function computeMenuPlacement(
    rect: MenuTriggerRect,
    viewportHeight: number,
): MenuPlacement {
    const up = rect.bottom + MENU_FLIP_SPACE_PX > viewportHeight;
    return {
        top: up ? rect.top - MENU_GAP_PX : rect.bottom + MENU_GAP_PX,
        left: rect.right,
        up,
    };
}
