import { describe, expect, it } from 'vitest';
import {
    composerPrimaryAction,
    isAbortedReason,
    queueSendVisible,
    showResume,
    snapshotResumable,
} from '../src/scripts/run-control.ts';

describe('composer 主按钮（IR-F）', () => {
    it('执行中为停止，空闲为发送', () => {
        expect(composerPrimaryAction({ busy: true })).toBe('stop');
        expect(composerPrimaryAction({ busy: false })).toBe('send');
    });

    it('执行中有草稿时仍显示入队发送按钮', () => {
        expect(queueSendVisible({ busy: true, hasDraft: true })).toBe(true);
        expect(queueSendVisible({ busy: true, hasDraft: false })).toBe(false);
        expect(queueSendVisible({ busy: false, hasDraft: true })).toBe(false);
    });

    it('仅空闲且可恢复时展示继续入口', () => {
        expect(showResume({ busy: false, resumable: true })).toBe(true);
        expect(showResume({ busy: true, resumable: true })).toBe(false);
        expect(showResume({ busy: false, resumable: false })).toBe(false);
    });

    it('reason=aborted 视为可恢复', () => {
        expect(isAbortedReason('aborted')).toBe(true);
        expect(isAbortedReason('final-answer')).toBe(false);
        expect(isAbortedReason(undefined)).toBe(false);
    });

    it('快照最新 Task aborted 视为可恢复', () => {
        expect(
            snapshotResumable({
                goals: [{ tasks: [{ status: 'succeeded' }, { status: 'aborted' }] }],
            }),
        ).toBe(true);
        expect(snapshotResumable({ goals: [{ tasks: [{ status: 'succeeded' }] }] })).toBe(false);
        expect(snapshotResumable(null)).toBe(false);
    });
});
