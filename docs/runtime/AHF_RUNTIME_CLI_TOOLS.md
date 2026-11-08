# Runtime 内置 CLI 工具执行契约

**状态**：实现对齐稿
**范围**：`packages/runtime/src/tool-gateway/builtin.ts`（工具声明）+ `packages/runtime/src/harness/tool-executor.ts`（`runCliTool` / `runShellTool`）+ `packages/runtime/src/utils/path-env.ts`（可执行路径兜底）。

## 1. 为什么需要一份契约

内置 CLI 工具（rg / fd / bat / eza / dua / difft / xh / sd）是模型看见的「结构化工具」，但底下是**厂商二进制**。二进制有三种天然不确定：

1. 同一语义在不同工具里表现不同（`fd` 默认按 regex 解析，`*.md` 会 parse error；`rg` 无匹配 exit 1 而不是 0）；
2. 输出体量与仓库规模成正比，可能撞进程缓冲上限；
3. 只存在于某个 PATH 目录里（Homebrew 在 `/opt/homebrew/bin`，系统自带在 `/usr/bin`）。

契约要做的，是把这些「工具差异」在 harness 层收敛成**模型可理解的成功/空结果/真错误**三态，避免模型把「没搜到」当故障、把「输出太大」当工具坏了。

## 2. 执行模型

```
ToolConfig.command (CliCommandSpec) → runCliTool → execFile(bin, argv, { cwd: workspaceRoot })
```

- 全程 **argv、不经 shell**，无注入面；`shell.run` 才走 `bash -o pipefail -lc`。
- `args` 模板里 `{key}` 必填、`{key?}` 可选；可选参数缺省时依次回退 `argDefaults[key]`，再缺省则不传。
- 只允许 `path` / `a` / `b` 指向工作区内（`resolve` + `realpath` 双重校验，防符号链接逃逸）。

## 3. 三态语义

| 结果 | 条件 | 返回 |
|---|---|---|
| 成功 | exit 0 | stdout（trim 后）；空输出由上层渲染成 `[ok] (no output)` |
| 空结果 | exit ∈ `noMatchExitCodes` | `noMatchContent`（默认 `(no matches)`），`ok: true` |
| 真错误 | 其他非零退出 / 超时 / 缺二进制 | `ok: false` + stderr（截 2000 字符）或 exec 错误消息 |

`noMatchExitCodes` 的存在理由：**「搜不到」不是故障**。rg 无匹配 exit 1、路径不存在 exit 2；只有后者该让模型重试或换路径。

## 4. 参数语义适配

| 机制 | 适用 | 行为 |
|---|---|---|
| `noMatchExitCodes` / `noMatchContent` | rg | exit 1 → 成功空结果 |
| `argDefaults` | rg 的 `path='.'` | 不传目录时补 `.`，否则 rg 在读 stdin（非 TTY）下阻塞或空退出 |
| `globFlag` | fd 的 `--glob` | pattern 含 `* ? [` **且不是合法 regex** 时前置该 flag；`.*\.md$` 这类合法 regex 保持 regex 语义 |
| `expectMutation` | sd | 退出 0 但目标文件未变化 → `ok:false`（`no change: pattern did not match`） |
| 命令分类 | shell.run | `readonly` / `network` / `unknown` / `dangerous` 四类决定审批粒度（见 `core/authz/command.ts`） |

## 5. 输出体量与截断

- 每个工具可配 `maxOutputChars`（默认 40 000，rg 为 60 000）。
- `execFile` 的 `maxBuffer` 固定 8 MB；超限抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，按真错误返回。
- rg **不使用 `--json`**：JSONL 带 begin/match/end 三段，体积约为纯文本的 10 倍，既容易撞 8 MB 缓冲，也会在 40k 截断点把一行 JSON 劈成非法片段。改用 `--no-heading --line-number --color=never`，输出形如 `path:line:text`。
- 截断固定追加 `…（output truncated）`，让模型知道「还有更多」，而不是以为结果就这么多。

## 6. PATH 与缺失安装

- `runCliTool` 用 `execFile(bin)`，**继承 API 进程的 PATH**；`shell.run` 继承登录 shell 的 PATH。两者可能不同。
- 系统自带命令（`grep` / `curl` / `sed`）在 `/usr/bin`，任何 PATH 下可用；Homebrew 工具（`rg` / `fd` / `xh`）只在 `/opt/homebrew/bin` 可用。
- 因此 API 启动期调用 `ensureExecutablePath()`：把平台上常见但缺失的目录（macOS 的 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.cargo/bin`）追加到 `PATH` 末尾。追加而非前置，避免遮蔽系统同名命令。
- 仍解析不到时：`ENOENT` → `detectPackageManager()`（macOS 只认 brew）→ 自动安装并重试一次。**包管理器本身不在 PATH 时安装必然失败**，错误文本会明确指出 `No package manager found`，这是 PATH 配置问题，不是工具问题。

## 7. 不做的事

- 不给 CLI 工具开放任意 flag：flag 由 specs 固化，需要自由参数时用 `shell.run`。
- 不在 harness 里解析工具私有输出格式（JSON/表格）：解析会随版本漂移，模型直接读文本更稳。
- 不把 `xh` 的失败归因于二进制：`xh` 声明 `minPermission: 'draft'`、能力 `net.fetch`，在 `workspace-write` 档下是 `gated`，走人工审批；`curl` 走 `shell.run` 的 `fs.exec` 是 auto。二者行为差异来自权限派生，不是工具实现。

## 8. 验收

`packages/runtime/test/tool-executor.test.ts`：

- rg 无匹配 → `ok:true` + `(no matches)`；路径不存在 → `ok:false`；
- rg 输出为纯文本（含 `path:line:text`，不含 JSON 事件）；
- `maxOutputChars` 生效并带截断标记；
- fd glob 自动加 `--glob`，合法 regex 不加，非法 regex 报真错误；
- sd 无改动检测。

`packages/runtime/test/path-env.test.ts`：PATH 兜底只补缺失且存在的目录，不重复、不改顺序、不遮蔽已有目录。
