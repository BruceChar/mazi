import { describe, expect, it } from 'vitest';
import {
    parseViewState,
    serializeViewState,
    viewStateStorageKey,
    workspaceTabsVisible,
} from '../src/scripts/view-state.ts';

describe('页面位置持久化（刷新后停留在当前页面）', () => {
    it('序列化 / 解析往返保留视图与 wiki 工作区', () => {
        const raw = serializeViewState({ view: 'wiki', wikiWorkspace: '/Users/bruce/nodejs/mazi' });
        expect(parseViewState(raw)).toEqual({
            view: 'wiki',
            wikiWorkspace: '/Users/bruce/nodejs/mazi',
        });
    });

    it('解析时裁剪工作区首尾空白', () => {
        expect(
            parseViewState(JSON.stringify({ view: 'wiki', wikiWorkspace: '  /tmp/project  ' })),
        ).toEqual({ view: 'wiki', wikiWorkspace: '/tmp/project' });
    });

    it('缺省 / 缺字段 → 合法空工作区', () => {
        expect(parseViewState(JSON.stringify({ view: 'wiki' }))).toEqual({
            view: 'wiki',
            wikiWorkspace: '',
        });
        expect(parseViewState(JSON.stringify({ view: 'chat' }))).toEqual({
            view: 'chat',
            wikiWorkspace: '',
        });
    });

    it('未知视图 / 非法 JSON / 非对象 → null（回退默认页）', () => {
        expect(parseViewState(null)).toBeNull();
        expect(parseViewState('')).toBeNull();
        expect(parseViewState('   ')).toBeNull();
        expect(parseViewState('{oops')).toBeNull();
        expect(parseViewState('"wiki"')).toBeNull();
        expect(parseViewState('[1,2]')).toBeNull();
        expect(parseViewState(JSON.stringify({ view: 'unknown' }))).toBeNull();
        expect(parseViewState(JSON.stringify({ view: 42 }))).toBeNull();
    });

    it('存储键是 sessionStorage 的 tab 级键（不跨 tab 串页）', () => {
        expect(viewStateStorageKey()).toBe('mazi.web.view-state');
    });
});

describe('主会话窗口视图 tab（会话 / 项目 Wiki）', () => {
    it('项目会话显示 tab，随心聊（无工作区）不显示', () => {
        expect(workspaceTabsVisible('chat', '/Users/bruce/nodejs/mazi')).toBe(true);
        expect(workspaceTabsVisible('chat', '')).toBe(false);
        expect(workspaceTabsVisible('chat', '   ')).toBe(false);
    });

    it('Wiki 页常驻 tab，便于切回对话', () => {
        expect(workspaceTabsVisible('wiki', '')).toBe(true);
    });

    it('其它整页视图不显示主会话 tab', () => {
        expect(workspaceTabsVisible('user-center', '/Users/bruce/nodejs/mazi')).toBe(false);
        expect(workspaceTabsVisible('system-settings', '/Users/bruce/nodejs/mazi')).toBe(false);
        expect(workspaceTabsVisible('lab', '/Users/bruce/nodejs/mazi')).toBe(false);
    });
});
