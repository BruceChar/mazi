import type { Capacity } from './capacity';
import type { GoalContract } from './goal';
import type { Turn } from './session';
import type { TurnContract } from './turn-contract';

/** Plan 层接口（MVP：可只产出单个 Turn，结构上支持多个） */
export interface Planner {
    plan(goal: GoalContract): Promise<TurnContract[]>;
    assembleCapacity(turn: Turn): Promise<Capacity>;
}
