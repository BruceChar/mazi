/**
 * BUILTIN_TOOL_PRESET —— 运行时内置工具预设（C5 后取代“仅 fs.read”局面）。
 * 提供现代 CLI 工具（rg/fd/bat/eza/dua/difft/xh/sd/sg），由通用命令执行器在
 * workspace 内以 argv 运行（不经 shell）。配置层可用同名 ToolConfig 覆盖/隐藏。
 * 工具名遵循各二进制实际命令（sd 为写入工具，需更高权限语义）。
 */
import type { ToolConfig } from '../config.js';

export const BUILTIN_TOOL_PRESET: ToolConfig[] = [
    {
        name: 'fs.read',
        description:
            '读取工作区内单个文件内容（utf8）。用于精确读文件正文；优先用 rg/fd/bat 定位内容与结构。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '文件路径（相对或绝对，须在工作区内）' },
            },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: [],
    },
    {
        name: 'rg',
        description:
            'ripgrep 全文/正则搜索：比 grep 快 5-20x，自动忽略 .gitignore 与二进制。分析项目时用 pattern+path 快速定位引用/定义，而不是逐文件读。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '搜索模式（正则）' },
                path: {
                    type: 'string',
                    description: '搜索起点路径（相对工作区；省略为整个工作区）',
                },
            },
            required: ['pattern'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'rg', args: ['--json', '-n', '{pattern}', '{path?}'] },
    },
    {
        name: 'fd',
        description:
            'fd 文件查找：比 find 快 2-8x，默认过滤隐藏/ignore 目录，支持 glob/正则、-t d/f 按类型。用来摸清目录结构与文件名。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '文件名 glob 或正则（省略则列出所有）' },
                path: { type: 'string', description: '起点目录（相对工作区；省略为当前）' },
            },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'fd', args: ['--json', '{pattern?}', '{path?}'] },
    },
    {
        name: 'bat',
        description: 'bat 查看文件（带行号高亮，--plain 关闭高亮）。替代 cat 读单文件。',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '文件路径（须在工作区内）' } },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'bat',
            args: ['--color', 'never', '--paging', 'never', '--line-range', ':1000', '{path}'],
        },
    },
    {
        name: 'eza',
        description: 'eza 现代 ls：彩色目录/文件列表（--tree 目录树）。快速看目录结构。',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '目录（相对工作区；省略为当前）' } },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'eza',
            args: ['--color', 'never', '--all', '--group-directories-first', '{path?}'],
        },
    },
    {
        name: 'dua',
        description:
            'dua-cli 目录磁盘占用统计（交互工具，无 TTY 时输出错误属正常；用于定位大目录）。',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '目录（相对工作区；省略为当前）' } },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'dua', args: ['{path?}'] },
    },
    {
        name: 'difft',
        description: 'difft 语义 diff（AST 级）：对比两份文件/代码差异，识别代码移动。',
        parameters: {
            type: 'object',
            properties: {
                a: { type: 'string', description: '左文件路径（相对工作区）' },
                b: { type: 'string', description: '右文件路径（相对工作区）' },
            },
            required: ['a', 'b'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'difft', args: ['--color', 'never', '{a}', '{b}'] },
    },
    {
        name: 'xh',
        description: 'xh 现代 HTTP 客户端（GET/POST JSON，干净输出）。注意会访问网络。',
        parameters: {
            type: 'object',
            properties: {
                method: { type: 'string', description: 'HTTP 方法（GET/POST…，可选默认 GET）' },
                url: { type: 'string', description: '目标 URL' },
            },
            required: ['url'],
        },
        minPermission: 'draft',
        sideEffects: ['net'],
        command: { bin: 'xh', args: ['{method?}', '{url}'] },
    },
    {
        name: 'sd',
        description:
            'sd 简单安全的字符串替换（写文件！参数为 pattern/replacement/path）。修改前请先读原文确认。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '查找串（字面/正则）' },
                replacement: { type: 'string', description: '替换串' },
                path: { type: 'string', description: '目标文件路径（须在工作区内）' },
            },
            required: ['pattern', 'replacement', 'path'],
        },
        minPermission: 'draft',
        irreversible: true,
        sideEffects: ['fs'],
        command: { bin: 'sd', args: ['{pattern}', '{replacement}', '{path}'] },
    },
    {
        name: 'sg',
        description: 'ast-grep（sg）：按语法树搜索/改写代码（--json），识别真实结构而非字符串。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'AST 模式（如 $A.method()）' },
                path: { type: 'string', description: '搜索目录（相对工作区；省略为当前）' },
            },
            required: ['pattern'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'sg', args: ['--json', '{pattern}', '{path?}'] },
    },
];
