/**
 * Versioned runtime tool registry.
 *
 * A run receives an immutable snapshot. Dynamic registration affects future
 * runs only, preventing a tool definition from changing after policy
 * derivation and before execution.
 */

import { createHash } from 'node:crypto';
import type { ToolConfig } from '../config.js';

export interface ToolRegistrySnapshot {
    version: number;
    digest: string;
    tools: ToolConfig[];
}

function validate(tool: ToolConfig): void {
    if (tool.name.trim().length === 0 || /\s/.test(tool.name)) {
        throw new Error(`非法工具名：${tool.name}`);
    }
    if (!Array.isArray(tool.sideEffects)) {
        throw new Error(`工具 ${tool.name} 缺少 sideEffects 声明`);
    }
}

function copyTool(tool: ToolConfig): ToolConfig {
    return { ...tool, sideEffects: [...tool.sideEffects] };
}

function digestOf(tools: readonly ToolConfig[]): string {
    const facts = tools
        .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            minPermission: tool.minPermission,
            irreversible: tool.irreversible ?? false,
            sideEffects: [...tool.sideEffects].sort(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

export class RuntimeToolRegistry {
    private readonly tools = new Map<string, ToolConfig>();
    private version = 1;
    private digest = '';

    constructor(initial: readonly ToolConfig[] = []) {
        for (const tool of initial) {
            validate(tool);
            this.tools.set(tool.name, copyTool(tool));
        }
        this.digest = digestOf([...this.tools.values()]);
    }

    register(tool: ToolConfig): number {
        validate(tool);
        this.tools.set(tool.name, copyTool(tool));
        this.version += 1;
        this.digest = digestOf([...this.tools.values()]);
        return this.version;
    }

    unregister(name: string): boolean {
        const removed = this.tools.delete(name);
        if (removed) {
            this.version += 1;
            this.digest = digestOf([...this.tools.values()]);
        }
        return removed;
    }

    snapshot(): ToolRegistrySnapshot {
        return {
            version: this.version,
            digest: this.digest,
            tools: [...this.tools.values()].map(copyTool),
        };
    }
}
