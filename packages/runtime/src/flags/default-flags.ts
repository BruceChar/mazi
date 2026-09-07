import type { FeatureFlagDefinition } from '@mazi/core';

/**
 * MVP 默认 Flag 集（总体设计 v1.2 §8 + MVP 文档 §5.5）。
 * 说明：Flag 只控制“上层消费”，事件 emit 与持久化不受任何 Flag 控制。
 */
export const DEFAULT_FLAGS: FeatureFlagDefinition[] = [
    {
        key: 'observe.enabled',
        description: 'Observer/观察消费开关（结构化工具观察已落地）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'reflect.enabled',
        description: 'Reflector 独立评估开关（MVP 退化为机械验收）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'approval.gate',
        description: '审批门（MVP 未实现，恒 true 表示不可逆工具一律拒绝）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'strategy.auto-escalate',
        description: '策略自动升降级（MVP 关闭）',
        type: 'boolean',
        defaultValue: false,
    },
    {
        key: 'planner.budget-slicing',
        description: '预算切片开关（关闭=均分兜底）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'planner.budget-slicing-mode',
        description: '切片模式：simple=均分（MVP）；weighted=加权（未实现）',
        type: 'string',
        defaultValue: 'simple',
    },
    {
        key: 'planner.routing-mode',
        description: '路由模式：simple=能力+成本（MVP）；full=六因子（未实现）',
        type: 'string',
        defaultValue: 'simple',
    },
    {
        key: 'memory.persistent',
        description: '持久化记忆（关闭=仅内存，不支持恢复）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'sandbox.enabled',
        description: '沙箱开关（MVP 无进程隔离，语义保留；生产强制 true）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'console.sink',
        description: '控制台事件打印 sink',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'user-profile.enabled',
        description: '用户交互记录生成开关（关闭仍记录事件，只是不生成记录）',
        type: 'boolean',
        defaultValue: true,
    },
    {
        key: 'user-profile.anonymize',
        description: '匿名化管道开关（默认 false=保留原始输入）',
        type: 'boolean',
        defaultValue: false,
    },
    {
        key: 'user-profile.retention-days',
        description: '记录保留天数（0=永久）',
        type: 'number',
        defaultValue: 0,
    },
];
