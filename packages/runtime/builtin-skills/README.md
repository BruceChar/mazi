# builtin-skills —— 内置技能落点（只读）

随 mazi runtime 分发的**内置技能**放在这里：随应用安装、只读、优先级最低
（项目级 `<workspace>/skills/` > 用户级 `$MAZI_HOME/skills/` > 本目录）。

- 每个内置技能一个目录：`<id>/manifest.json` + `tools/` + `handlers/` + `memory/` + `templates/` + `validators/`（规范见 docs/能力包规范.md §4–§6）。
- **不要**把领域示例（成功日记/身材/财务等）放在这里：领域功能是用户资产，由用户/项目目录承载。
- 可用环境变量 `MAZI_BUILTIN_SKILLS_DIR` 覆盖本目录（测试 / 定制发行版）。
- UI 的技能面板对本目录只读：不提供新建/编辑，只能查看与挂载/卸载。

当前版本未随包发布任何内置技能，因此目录内只有本说明文件。
