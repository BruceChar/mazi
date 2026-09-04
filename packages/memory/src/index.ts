/**
 * @mazi/memory：core MemoryStore 的 node:sqlite（DatabaseSync）落地实现。
 * 设计依据：MVP 设计文档 v1.0 §3.2 包职责行 / §4.3 D1 表结构 / §8 F8。
 */

export type { DatabaseSync } from 'node:sqlite';
export { createSchema } from './schema.js';
export { SqliteMemoryStore } from './sqlite-store.js';
