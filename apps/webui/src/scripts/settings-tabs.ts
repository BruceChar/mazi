/**
 * settings-tabs —— 系统设置分类导航（docs/webui.md §3.10）。
 * 纯常量，供 App.vue 与单测共用。
 */
export interface SettingsTab {
    id: string;
    label: string;
    icon: string;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
    { id: 'general', label: 'General', icon: 'settings' },
    { id: 'model', label: 'Model', icon: 'cpu' },
    { id: 'providers', label: 'Providers', icon: 'plug' },
    { id: 'auth', label: 'Auth', icon: 'shield' },
    { id: 'about', label: 'About', icon: 'info' },
];
