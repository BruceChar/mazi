/**
 * RuntimePorts —— 能力接入点登记表（宿主 setter / 插件注册的唯一入口）。
 *
 * kernel 只负责服务生命周期；运行期可替换的能力（目录、技能包、模型
 * 恢复、审批 seam、判官、规划器、工具、prompt pack、agent role）经
 * 这里登记，读取方按名字取值，不再各自持有可写字段。
 */
export type RuntimePortName =
    | 'catalog'
    | 'skillProvider'
    | 'modelRecovery'
    | 'approvalSeam'
    | 'questionClassifier'
    | 'semanticJudge'
    | 'replanPlanner'
    | 'taskPlanner'
    | 'tool'
    | 'promptPack'
    | 'agentRole';

export class RuntimePorts {
    private readonly slots = new Map<RuntimePortName, unknown>();

    /** 登记/替换一个接入点；返回撤销函数（撤销不会影响后来者覆盖的值）。 */
    set(name: RuntimePortName, value: unknown): () => void {
        this.slots.set(name, value);
        return () => {
            if (this.slots.get(name) === value) this.slots.delete(name);
        };
    }

    get<T>(name: RuntimePortName): T | undefined {
        return this.slots.get(name) as T | undefined;
    }

    has(name: RuntimePortName): boolean {
        return this.slots.has(name);
    }

    names(): RuntimePortName[] {
        return [...this.slots.keys()];
    }
}
