# builtin-skills —— 内置 Skill 落点（只读）

随 mazi runtime 分发的**内置 Skill** 放在这里：随应用安装、只读、优先级最低
（项目级 `<workspace>/skills/` > 用户级 `$MAZI_HOME/skills/` > 本目录）。

## 一个 Skill 就是一个目录 + 一个 SKILL.md

```
<id>/
├── SKILL.md        # 必需：YAML frontmatter（name/description）+ Markdown 指令正文
└── …               # 可选：references/ scripts/ assets/ 等随包文件
```

- frontmatter 至少要有 `name` 与 `description`（做什么 + 什么时候用），机制见 docs/能力包规范.md §1–§3。
- Skill **不注册工具、不声明权限、不拥有数据集合**；它教模型用已有工具完成任务。
- 需要新工具/新副作用面的功能属于**插件或 MCP server**，不放进 SKILL.md。
- 不要内置领域 Skill（成功日记/身材/财务等）：领域功能是用户资产，由用户或项目目录承载。

可用 `MAZI_BUILTIN_SKILLS_DIR` 覆盖本目录（测试 / 定制发行版）。UI 技能面板对本目录只读。

当前版本未随包发布任何内置 Skill，因此目录内只有本说明文件。
