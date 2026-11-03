import { join } from 'node:path';
import { loadEvalDataset } from './dataset.js';
import type { EvalTask } from './types.js';

export function loadBaselineDataset(): EvalTask[] {
    return loadEvalDataset(join(import.meta.dirname, '../../tasks/p0-baseline.json'));
}
