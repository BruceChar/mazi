/**
 * ProfileStore —— 实现 AHF_RUNTIME_PROVIDER §7.4（文件实现）。
 * JSON 快照读写；文件缺失/损坏 → load 返回 null（损坏记日志）。faux 数据不落盘由
 * collector.snapshot() 侧保证（profile.ts），store 不做过滤。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProfileSnapshot } from './profile.js';

export interface ProfileStore {
    load(): Promise<ProfileSnapshot | null>;
    save(snapshot: ProfileSnapshot): Promise<void>;
}

export interface ProfileStoreLogger {
    warn(message: string): void;
}

export interface FileProfileStoreOptions {
    logger?: ProfileStoreLogger;
}

export class FileProfileStore implements ProfileStore {
    private readonly filePath: string;
    private readonly logger: ProfileStoreLogger;

    constructor(filePath: string, options: FileProfileStoreOptions = {}) {
        this.filePath = filePath;
        this.logger = options.logger ?? { warn: () => undefined };
    }

    async load(): Promise<ProfileSnapshot | null> {
        let raw: string;
        try {
            raw = readFileSync(this.filePath, 'utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return null;
            this.logger.warn(`profile store load failed: ${(error as Error).message}`);
            return null;
        }
        try {
            const parsed = JSON.parse(raw) as ProfileSnapshot;
            if (
                typeof parsed !== 'object' ||
                parsed === null ||
                typeof parsed.savedAt !== 'number'
            ) {
                throw new Error('invalid snapshot shape');
            }
            return parsed;
        } catch (error) {
            this.logger.warn(`profile store corrupted: ${(error as Error).message}`);
            return null;
        }
    }

    async save(snapshot: ProfileSnapshot): Promise<void> {
        const dir = dirname(this.filePath);
        mkdirSync(dir, { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
        renameSync(tmp, this.filePath);
    }
}
