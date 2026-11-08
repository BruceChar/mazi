import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { PROJECT_WIKI_CLAIMS_HEADER } from './project-wiki-claims.js';

export const PROJECT_WIKI_AGENTS_START = '<!-- WIKI:START -->';
export const PROJECT_WIKI_AGENTS_END = '<!-- WIKI:END -->';

export const PROJECT_WIKI_ARCHITECTURE_TEMPLATE = `# 项目全貌与结构

> 适用于软件、研究、写作、设计、运营等任意项目。

## 目标与边界
TODO：项目解决什么问题、服务谁、当前阶段，以及明确不做什么。

## 当前内容
TODO：主要组成部分、参与者、关键对象和它们之间的关系。
TODO：关键工作流、信息流或交付流；有依赖时说明前后顺序。

## 约束与例外
TODO

## 来源与证据
TODO
`;

export const PROJECT_WIKI_CONVENTIONS_TEMPLATE = `# 工作方式与约定

> 适用于任意项目类型。记录团队如何协作、如何判断质量，以及不可违反的规则。

## 目标与边界
TODO：这些约定保护什么结果，适用于哪些人或工作范围。

## 当前内容
TODO：真实的工作原则、协作方式、命名或格式规则、评审与确认流程。

## 约束与例外
TODO：红线、允许的例外、例外由谁确认。

## 来源与证据
TODO：约定出自哪些文档、会议、样例或系统配置。
`;

export const PROJECT_WIKI_COMMANDS_TEMPLATE = `# 常用流程与命令

> 同时记录人工流程与可执行命令；没有命令的项目可以只写步骤。

## 工作流程
TODO

## 可执行入口
TODO

## 来源与证据
TODO
`;

export const PROJECT_WIKI_DEPLOYMENT_TEMPLATE = `# 环境、资源与交付

> 不限定软件部署。记录开展项目所需的环境、工具、资源，以及成果如何交付和维护。

## 目标与边界
TODO：需要哪些环境、资源和交付条件，范围到哪里。

## 当前内容
TODO：环境与工具、账号或访问方式、素材与数据、发布或交付步骤。

## 约束与例外
TODO：安全、合规、权限、备份与回退要求，以及允许的例外。

## 来源与证据
TODO：配置、操作手册、平台页面或交付记录。
`;

export const PROJECT_WIKI_CURRENT_TEMPLATE = `# 当前状态

## 现在
- 阶段：TODO
- 进行中：TODO

## 阻塞与风险
- 阻塞：无
- 风险：TODO

## 下一步
- TODO

## 最近变化
- TODO

## 会话活动
<!-- activity:start -->
<!-- activity:end -->
`;

export const PROJECT_WIKI_DECISIONS_TEMPLATE = `# 决策记录（ADR）
<!-- 格式：## YYYY-MM-DD 决策标题
背景 / 备选 / 结论（为什么选 X 不选 Y） -->
`;

export const PROJECT_WIKI_LESSONS_TEMPLATE = `# 踩坑教训
<!-- 格式：- [日期] 教训（一句话）→ 规避动作 -->
`;

export const PROJECT_WIKI_CLAIMS_TEMPLATE = `${PROJECT_WIKI_CLAIMS_HEADER}

[claims]
`;

export interface ProjectWikiProjectDetection {
    projectName: string;
    projectType: string;
    modules: string[];
    moduleMap: string;
    commands: string;
    deployHints: string[];
}

export function detectProject(workspace: string, perModule = false): ProjectWikiProjectDetection {
    const projectType = detectProjectType(workspace);
    const modules = detectModules(workspace);
    const moduleRows = modules.map((module) => {
        const wiki = perModule ? `[AGENTS.md](../../${module}/AGENTS.md)` : '未初始化';
        return `| ${module} | TODO | TODO | ${wiki} |`;
    });
    const moduleMap =
        moduleRows.length > 0
            ? [
                  '',
                  '## 项目地图',
                  '| 路径 | 职责 | 主要输入或产出 | 项目 wiki |',
                  '|---|---|---|---|',
                  ...moduleRows,
                  '',
              ].join('\n')
            : '';
    return {
        projectName: basename(workspace),
        projectType,
        modules,
        moduleMap,
        commands: extractCommands(workspace),
        deployHints: detectDeployHints(workspace),
    };
}

export function renderProjectWikiIndex(detection: ProjectWikiProjectDetection): string {
    return `# ${detection.projectName}

> 项目摘要：TODO（做什么、给谁用、当前阶段）
> 项目类型：${detection.projectType}

## 速查
| 想知道 | 去哪 |
|---|---|
| 项目全貌与结构 | overview/architecture.md |
| 工作方式与约定 | overview/conventions.md |
| 常用流程与命令 | overview/commands.md |
| 环境、资源与交付 | overview/deployment.md |
| 当前进行中的事 | state/current.md |
| 历史决策 | overview/decisions/ |

## 红线（违反会损害结果或造成返工）
1. TODO

${detection.moduleMap}
## 最近更新
<!-- recent:start -->
<!-- recent:end -->
`;
}

export function projectWikiCommandsTemplate(commands: string): string {
    return PROJECT_WIKI_COMMANDS_TEMPLATE.replace(
        '## 可执行入口\nTODO',
        `## 可执行入口\n${commands}`,
    );
}

export function projectWikiDeploymentTemplate(hints: readonly string[]): string {
    if (hints.length === 0) return PROJECT_WIKI_DEPLOYMENT_TEMPLATE;
    return PROJECT_WIKI_DEPLOYMENT_TEMPLATE.replace(
        '> 不限定软件部署。记录开展项目所需的环境、工具、资源，以及成果如何交付和维护。\n',
        `> 不限定软件部署。记录开展项目所需的环境、工具、资源，以及成果如何交付和维护。\n\n${hints.join('\n')}\n`,
    );
}

export function projectWikiAgentsBlock(): string {
    return `${PROJECT_WIKI_AGENTS_START}
# Agent 指南（Project Wiki）
- 项目知识库在 wiki/INDEX.md，会话开始必读；开始工作前先查对应模块知识
- Project Wiki 由 Mazi runtime 内置维护；claims 与 oid 由 runtime 计算
- 不要手改 wiki/claims.toml；会话结束后的沉淀由 runtime 负责
- 项目地图见 wiki/INDEX.md
${PROJECT_WIKI_AGENTS_END}`;
}

export function moduleWikiAgentsBlock(): string {
    return `${PROJECT_WIKI_AGENTS_START}
# Agent 指南（Project Wiki）
- 本部分知识库在 wiki/INDEX.md，开始工作前先查
- 全局 Project Wiki 由仓库根 AGENTS.md 指向
${PROJECT_WIKI_AGENTS_END}`;
}

function detectProjectType(workspace: string): string {
    const found: string[] = [];
    const packageJson = readJson(join(workspace, 'package.json'));
    if (packageJson) {
        const name = typeof packageJson.name === 'string' ? ` (${packageJson.name})` : '';
        found.push(`Node.js${name}`);
    }
    const cargo = readText(join(workspace, 'Cargo.toml'));
    if (cargo) {
        const name = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
        found.push(name ? `Rust (${name})` : 'Rust');
    }
    const pyproject = readText(join(workspace, 'pyproject.toml'));
    if (pyproject) {
        const name = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
        found.push(name ? `Python (${name})` : 'Python');
    }
    if (existsSync(join(workspace, 'go.mod'))) found.push('Go');
    if (existsSync(join(workspace, 'pom.xml'))) found.push('Java (Maven)');
    return found.length > 0 ? found.join('、') : '通用项目（未检测到技术清单）';
}

function detectModules(workspace: string): string[] {
    const manifests = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml'];
    const modules = new Set<string>();
    for (const group of ['apps', 'packages', 'services', 'libs', 'modules']) {
        const dir = join(workspace, group);
        for (const child of directoryNames(dir)) {
            if (manifests.some((name) => existsSync(join(dir, child, name)))) {
                modules.add(`${group}/${child}`);
            }
        }
    }
    return [...modules].sort();
}

function extractCommands(workspace: string): string {
    const sections: string[] = [];
    const packageJson = readJson(join(workspace, 'package.json'));
    const scripts =
        packageJson?.scripts && typeof packageJson.scripts === 'object'
            ? (packageJson.scripts as Record<string, unknown>)
            : {};
    const scriptEntries = Object.entries(scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .slice(0, 25);
    if (scriptEntries.length > 0) {
        sections.push(
            [
                '### npm scripts',
                ...scriptEntries.map(([name, value]) => `- \`${name}\` → \`${value}\``),
            ].join('\n'),
        );
    }
    const makefile = readText(join(workspace, 'Makefile'));
    if (makefile) {
        const targets = [
            ...new Set(
                [...makefile.matchAll(/^([A-Za-z][\w.-]*):(?:\s|$)/gm)]
                    .map((match) => match[1] ?? '')
                    .filter(Boolean),
            ),
        ].slice(0, 25);
        if (targets.length > 0) {
            sections.push(
                ['### Make', ...targets.map((target) => `- \`make ${target}\``)].join('\n'),
            );
        }
    }
    return sections.join('\n\n') || 'TODO（未检测到任务定义文件，请手填常用流程或命令）';
}

function detectDeployHints(workspace: string): string[] {
    const hints: string[] = [];
    if (existsSync(join(workspace, '.github', 'workflows'))) {
        hints.push('- 检测到 GitHub Actions');
    }
    if (existsSync(join(workspace, 'Dockerfile'))) hints.push('- 检测到 Dockerfile');
    if (existsSync(join(workspace, 'docker-compose.yml'))) {
        hints.push('- 检测到 docker-compose.yml');
    }
    if (existsSync(join(workspace, 'k8s'))) hints.push('- 检测到 k8s/');
    if (existsSync(join(workspace, 'helm')) || existsSync(join(workspace, 'charts'))) {
        hints.push('- 检测到 Helm chart');
    }
    return hints;
}

function directoryNames(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
}

function readJson(file: string): Record<string, unknown> | undefined {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        return parsed !== null && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

function readText(file: string): string | undefined {
    try {
        return statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined;
    } catch {
        return undefined;
    }
}
