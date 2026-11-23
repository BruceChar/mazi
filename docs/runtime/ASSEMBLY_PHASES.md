# Runtime 装配分段与冷加载

本文件定义 `HarnessRuntime` 的装配契约。目标有三个，彼此独立：

| 目标 | 判据 |
| --- | --- |
| 装配可读 | 每个对象只在一处创建，依赖显式可见 |
| 启动可控 | 构造期不触碰 IO，句柄在首次使用时打开 |
| 可扩展 | 新增一个协作者只需改 2 个文件 |

## 一、为什么按"是否触碰外部世界"分相

装配顺序的真正约束不是"谁先 new"，而是"谁先产生不可回滚的外部效果"：SQLite 句柄、
目录扫描、后台迁移。按这一条切分，得到四相：

| 相 | 内容 | 外部效果 | 失败方式 |
| --- | --- | --- | --- |
| P0 纯值 | 配置归一化、开关、默认值 | 无 | 返回值/异常 |
| P1 纯对象 | 事件总线、hook runner、fault pipeline、工具注册表、策略、resolver 壳 | 无 | 构造异常 |
| P2 回边绑定 | 需要互相引用的对象（engine ↔ runtime 命令、tool plane ↔ 审批 seam） | 无 | 启动期断言 |
| P3 资源 | SQLite、文件、wiki 索引 | 句柄/文件 | 首次使用才付钱 |

P0/P1/P2 必须同步、廉价、可单测；P3 一律延迟。

## 二、两遍装配：create → bind

顺序耦合不能靠"人工维护数组顺序 + 运行时断言"解决，要靠结构消除：

1. **create 相**：每个模块只创建自己拥有的对象，**不读其它平面的字段**；
2. **bind 相**：所有跨模块接线在此完成，允许读任意平面，允许闭包延迟（回边）。

create 相内部无依赖，因此模块数组的排列对正确性没有影响；数组只承担"哪些模块启用"，
不承担拓扑。bind 相的回边用闭包或二次赋值，不引入新的构造顺序约束。

## 三、模块列表与两段划分

核心不是"固定 6 个模块"，而是三个不变量：事件总线、能力表（ports）、会话串行锁。
任何功能都绕不开它们，因此这几段列在 `core`：

```
core:     config, intake, observability, memoryCore, intelligence, tools, session
features: analysis, delegation, wiki/projectWiki, blackboard, plugins
```

- `core` 缺一即无法运行；
- `features` 通过 `enabled(deps)` 条件跳过：`RunOptions.disabledModules` 传
  `['analysis']` / `['delegation']` 即关闭对应模块，平面键为 `undefined`；
  读接口降级（角色/边查询返回空），写接口与 `tocAnalyst` 明确报「模块未启用」。
- 新增功能默认进 `features`；只有被所有执行路径依赖才升级进 `core`。

## 四、静态模块 vs 动态注入

判据一句话：**替换它是否需要重排构造顺序？**

| | 静态模块（数组） | 动态注入（ports / kernel / hooks） |
| --- | --- | --- |
| 管什么 | 对象图成员（有构造、有生命周期） | 能力实现（目录、技能包、审批 seam、模型恢复、工具、prompt pack、agent role） |
| 何时 | 编译期，改代码 | 运行期，宿主/插件调用 |
| 改动范围 | 模块文件 + 平面接口 | `ports.set(...)` / `kernel.provide(...)` |
| 允许写平面 | 是（只写 `owned` 声明的键） | **否** |

硬规则：

1. 插件只允许写 `ports`、`kernel`、`hooks` 三张表，禁止写平面字段；
2. 插件需要新的对象图成员（新存储、新引擎）时，不是插件，而是新增模块；
3. `ports` 只做"能力注入"，不做依赖图解析、不做字符串反射，保证启动可预测。

## 五、owned 声明与自检

每个模块导出 `owned: readonly string[]`，形如 `['memory.goalStore', 'memory.memoryManager']`。
装配结束执行一次校验（仅在 dev/测试环境开启）：

- 每个模块 `owned` 声明的键都已填值（非 `undefined`）；
- 不存在"被读取但从未被任何模块声明"的键（可选，通过代理记录读取）。

这一步把"删模块导致的隐性破坏"从运行时提前到启动期。生产环境跳过以保证启动速度。

## 六、冷加载：付费点与幂等

P3 资源统一由 `LazySlot` 包裹：属性访问触发 open，单飞，只 open 一次。
因此 `ctx.memory.goalStore` 在任何构造/bind 阶段都只是代理视图，不产生句柄。

三个付费点（真实入口，不额外声明）：

| 入口 | 打开的资源 |
| --- | --- |
| 首次建会话 / 执行 Goal | goalStore、memoryManager、behaviorRecorder、questionService、failureLedger、promptPacks |
| 首次工具执行（需要时） | effectStore、blackboard |
| 首次访问分析/委派 | analysis stack、delegation stack |
| 首次使用 wiki / 项目 wiki | WikiService、ProjectWikiService（目录探测与索引） |

`close()` 幂等：只关闭已 open 的槽，未 open 的槽不产生副作用；重复 close 不抛错。

## 七、验收口径

1. 冷构造（不触达任何 store 方法）不打开 SQLite，耗时 < 3ms；
2. 冷构造后 `close()` 不打开任何资源；
3. `core` 模块的 `owned` 键在装配结束时全部有值；
4. `features` 模块可通过 `enabled(config)` 关闭，且关闭后不产生句柄；
5. 新增协作者的 diff 只落在 2 个文件（模块文件 + 平面接口）；
6. 每个模块的 create/bind 合计 < 80 行。

## 八、迁移顺序

1. **切段**：把构造函数按相拆成 `assemble*` 方法，纯搬运、零语义变化；
2. **懒化**：把 P3 资源换成 `LazySlot` 视图，构造期不再 open；
3. **模块化**：把 `assemble*` 搬成 `assembly/modules/*`，runtime 只保留数组循环与 owned 校验。

三步各自独立提交，每步都必须保持全量测试通过。配置树/多宿主不在本文件范围内（YAGNI）。
