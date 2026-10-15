/**
 * Feature 定义持久化 —— $MAZI_HOME/features.json（{ "features": [...] }）。
 * 与旧执行模型的 flags.json 无关（旧文件已停止读取）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FeatureDefinition } from '@mazi/core';
import { coerceFeatureDefinition } from './validate.js';

export interface FeatureStore {
    read(): Promise<FeatureDefinition[]>;
    write(features: readonly FeatureDefinition[]): Promise<void>;
}

/** 文件实现：坏记录丢弃、文件损坏降级为空集合并回调告警（不阻断运行）。 */
export class FileFeatureStore implements FeatureStore {
    constructor(
        private readonly file: string,
        private readonly onError?: (message: string) => void,
    ) {}

    async read(): Promise<FeatureDefinition[]> {
        if (!existsSync(this.file)) return [];
        let parsed: { features?: unknown };
        try {
            parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { features?: unknown };
        } catch (error) {
            this.onError?.('features.json 解析失败：' + String(error));
            return [];
        }
        if (!Array.isArray(parsed.features)) return [];
        const features: FeatureDefinition[] = [];
        for (const raw of parsed.features) {
            const coerced = coerceFeatureDefinition(raw);
            if (coerced === undefined) {
                this.onError?.('features.json 含非法特性定义，已跳过');
                continue;
            }
            features.push(coerced);
        }
        return features;
    }

    async write(features: readonly FeatureDefinition[]): Promise<void> {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(
            this.file,
            JSON.stringify({ features: [...features] }, null, 2) + '\n',
            'utf8',
        );
    }
}

/** 进程内实现（测试 / 无状态宿主）。 */
export class MemoryFeatureStore implements FeatureStore {
    private features: FeatureDefinition[];

    constructor(initial: readonly FeatureDefinition[] = []) {
        this.features = [...initial];
    }

    async read(): Promise<FeatureDefinition[]> {
        return [...this.features];
    }

    async write(features: readonly FeatureDefinition[]): Promise<void> {
        this.features = [...features];
    }
}
