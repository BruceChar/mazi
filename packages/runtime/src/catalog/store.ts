/**
 * catalog/store —— CatalogStore SPI（长期凭证的落地边界）。
 *
 * 语义：
 *   - load/save：整份目录事实（含 epoch 与 catalog_changes）原子读写；
 *   - appendUsage / listUsage、appendHealth / listHealth：账本与观测为 append-only 独立流；
 *   - 内存实现用于测试；文件实现用于本仓库默认部署（$MAZI_HOME/catalog/）。
 * 上层只依赖本接口，后续可新增 Sqlite/Postgres 实现而不改业务。
 */

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { HealthSample, UsageRecord } from '@mazi/core';
import { type CatalogFacts, cloneCatalogFacts, emptyCatalogFacts } from './state.js';

export interface CatalogStore {
    loadFacts(): Promise<CatalogFacts>;
    saveFacts(facts: CatalogFacts): Promise<void>;
    appendUsage(record: UsageRecord): Promise<void>;
    listUsage(): Promise<UsageRecord[]>;
    appendHealth(sample: HealthSample): Promise<void>;
    listHealth(): Promise<HealthSample[]>;
}

export class MemoryCatalogStore implements CatalogStore {
    private facts: CatalogFacts;
    private readonly usage: UsageRecord[] = [];
    private readonly health: HealthSample[] = [];

    constructor(initial: CatalogFacts = emptyCatalogFacts()) {
        this.facts = cloneCatalogFacts(initial);
    }

    async loadFacts(): Promise<CatalogFacts> {
        return cloneCatalogFacts(this.facts);
    }

    async saveFacts(facts: CatalogFacts): Promise<void> {
        this.facts = cloneCatalogFacts(facts);
    }

    async appendUsage(record: UsageRecord): Promise<void> {
        this.usage.push(structuredClone(record));
    }

    async listUsage(): Promise<UsageRecord[]> {
        return this.usage.map((item) => structuredClone(item));
    }

    async appendHealth(sample: HealthSample): Promise<void> {
        this.health.push(structuredClone(sample));
    }

    async listHealth(): Promise<HealthSample[]> {
        return this.health.map((item) => structuredClone(item));
    }
}

export interface FileCatalogStoreOptions {
    /** 目录根（缺省调用方传入 $MAZI_HOME/catalog） */
    logger?: { warn(message: string): void };
}

const FACTS_FILE = 'catalog.json';
const USAGE_FILE = 'usage_records.jsonl';
const HEALTH_FILE = 'health_samples.jsonl';

/** JSON 文件实现：事实整份原子替换；账本/观测追加 JSONL（凭证不重写、不删除）。 */
export class FileCatalogStore implements CatalogStore {
    private readonly dir: string;
    private readonly logger: { warn(message: string): void };

    constructor(dir: string, options: FileCatalogStoreOptions = {}) {
        this.dir = dir;
        this.logger = options.logger ?? { warn: () => undefined };
    }

    async loadFacts(): Promise<CatalogFacts> {
        const file = join(this.dir, FACTS_FILE);
        if (!existsSync(file)) return emptyCatalogFacts();
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CatalogFacts>;
        return normalizeFacts(parsed);
    }

    async saveFacts(facts: CatalogFacts): Promise<void> {
        mkdirSync(this.dir, { recursive: true });
        const file = join(this.dir, FACTS_FILE);
        const tmp = file + '.' + String(process.pid) + '.tmp';
        writeFileSync(tmp, JSON.stringify(facts, null, 2), 'utf8');
        renameSync(tmp, file);
    }

    async appendUsage(record: UsageRecord): Promise<void> {
        this.appendLine(USAGE_FILE, record);
    }

    async listUsage(): Promise<UsageRecord[]> {
        return this.readLines<UsageRecord>(USAGE_FILE);
    }

    async appendHealth(sample: HealthSample): Promise<void> {
        this.appendLine(HEALTH_FILE, sample);
    }

    async listHealth(): Promise<HealthSample[]> {
        return this.readLines<HealthSample>(HEALTH_FILE);
    }

    private appendLine(file: string, value: unknown): void {
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(join(this.dir, file), JSON.stringify(value) + '\n', 'utf8');
    }

    private readLines<T>(file: string): T[] {
        const path = join(this.dir, file);
        if (!existsSync(path)) return [];
        const lines = readFileSync(path, 'utf8').split('\n');
        const out: T[] = [];
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            try {
                out.push(JSON.parse(line) as T);
            } catch (error) {
                this.logger.warn('catalog store: corrupted line in ' + file + ': ' + String(error));
            }
        }
        return out;
    }
}

function normalizeFacts(parsed: Partial<CatalogFacts>): CatalogFacts {
    const base = emptyCatalogFacts();
    return {
        epoch: typeof parsed.epoch === 'number' ? parsed.epoch : base.epoch,
        vendors: parsed.vendors ?? base.vendors,
        providers: parsed.providers ?? base.providers,
        models: parsed.models ?? base.models,
        offerings: parsed.offerings ?? base.offerings,
        pricingPlans: parsed.pricingPlans ?? base.pricingPlans,
        aliases: parsed.aliases ?? base.aliases,
        driverConfigs: parsed.driverConfigs ?? base.driverConfigs,
        changes: parsed.changes ?? base.changes,
    };
}
