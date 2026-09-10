/**
 * BUILTIN_TOOL_PRESET - built-in CLI tool preset.
 *
 * Lets the model inspect project structure and file contents efficiently.
 * Every CLI tool runs inside the workspace as argv (no shell) via the generic
 * command runner; a missing binary is auto-installed and the call retried once.
 * Config-layer tools with the same name override these.
 */
import type { ToolConfig } from '../config.js';

export const BUILTIN_TOOL_PRESET: ToolConfig[] = [
    {
        name: 'fs.read',
        description:
            'Read a single text file inside the workspace (utf8). Use when you need the exact full content of one file.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'File path (relative or absolute, must be inside the workspace)',
                },
            },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: [],
    },
    {
        name: 'rg',
        description:
            'Search file contents in the workspace with a regex pattern. Use to find where something is referenced or defined. If unsure about flags or syntax, run `rg --help` first.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex pattern to search for' },
                path: {
                    type: 'string',
                    description:
                        'Directory/file to search (relative to workspace; omit = whole workspace)',
                },
            },
            required: ['pattern'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'rg',
            args: ['--json', '-n', '{pattern}', '{path?}'],
            installPackage: 'ripgrep',
        },
    },
    {
        name: 'fd',
        description:
            'Find files and directories in the workspace by name. Use to explore the project structure and locate files. If unsure about flags, run `fd --help` first.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'File name glob or regex (omit to list everything)',
                },
                path: {
                    type: 'string',
                    description:
                        'Start directory (relative to workspace; omit = current directory)',
                },
            },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'fd',
            args: ['--color=never', '{pattern?}', '{path?}'],
            installPackage: 'fd',
        },
    },
    {
        name: 'bat',
        description:
            'Print a single file with line numbers. Use to read one file precisely. If unsure about flags, run `bat --help` first.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path (must be inside the workspace)' },
            },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'bat',
            args: ['--color', 'never', '--paging', 'never', '--line-range', ':1000', '{path}'],
            installPackage: 'bat',
        },
    },
    {
        name: 'eza',
        description:
            'List the contents of a directory (files and subdirectories). Use to see what a directory contains. If unsure about flags, run `eza --help` first.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description:
                        'Directory to list (relative to workspace; omit = current directory)',
                },
            },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'eza',
            // -1 单列输出、--git-ignore 跳过被忽略的大目录，避免 1MB 缓冲/超时
            args: ['--color=never', '-1', '--group-directories-first', '--git-ignore', '{path?}'],
            installPackage: 'eza',
        },
    },
    {
        name: 'dua',
        description:
            'Show how much disk space directories use. Use when you need to know which directories are large. If unsure about flags, run `dua --help` first.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description:
                        'Directory to analyze (relative to workspace; omit = current directory)',
                },
            },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'dua', args: ['{path?}'], installPackage: 'dua-cli' },
    },
    {
        name: 'difft',
        description:
            'Compare two files and show their differences (semantic, understands code moves). Use to see what changed between two versions of a file. If unsure about flags, run `difft --help` first.',
        parameters: {
            type: 'object',
            properties: {
                a: { type: 'string', description: 'Left file path (relative to workspace)' },
                b: { type: 'string', description: 'Right file path (relative to workspace)' },
            },
            required: ['a', 'b'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'difft',
            args: ['--color', 'never', '{a}', '{b}'],
            installPackage: 'difft',
        },
    },
    {
        name: 'xh',
        description:
            'Send an HTTP request and show the response. Use when the task needs data from the network (real requests are sent). If unsure about flags, run `xh --help` first.',
        parameters: {
            type: 'object',
            properties: {
                method: {
                    type: 'string',
                    description: 'HTTP method (GET/POST/...; optional, defaults to GET)',
                },
                url: { type: 'string', description: 'Target URL' },
            },
            required: ['url'],
        },
        minPermission: 'draft',
        sideEffects: ['net'],
        command: { bin: 'xh', args: ['{method?}', '{url}'], installPackage: 'xh' },
    },
    {
        name: 'sd',
        description:
            'Replace text in a file (this tool WRITES the file). Use to apply a string/regex substitution to one file. Read the file first to confirm before editing. If unsure about flags, run `sd --help` first.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Text to find (literal or regex)' },
                replacement: { type: 'string', description: 'Replacement text' },
                path: {
                    type: 'string',
                    description: 'Target file path (must be inside the workspace)',
                },
            },
            required: ['pattern', 'replacement', 'path'],
        },
        minPermission: 'draft',
        irreversible: true,
        sideEffects: ['fs'],
        command: {
            bin: 'sd',
            args: ['{pattern}', '{replacement}', '{path}'],
            installPackage: 'sd',
        },
    },
    {
        name: 'sg',
        description:
            'Search code by syntax-tree pattern (ast-grep) to find code structures such as functions or method calls. Use when searching by structure, not by raw text. If unsure about flags, run `sg --help` first.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'AST pattern (e.g. $A.method())' },
                path: {
                    type: 'string',
                    description:
                        'Directory to search (relative to workspace; omit = current directory)',
                },
            },
            required: ['pattern'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: {
            bin: 'sg',
            args: ['--json', '{pattern}', '{path?}'],
            installPackage: 'ast-grep',
        },
    },

    {
        name: 'cat',
        description:
            'Print the contents of one file. Use to read a plain file when line numbers are not needed (prefer bat when available). If unsure about flags, first run: cat --help',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path (must be inside the workspace)' },
            },
            required: ['path'],
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'cat', args: ['{path}'] },
    },
    {
        name: 'ls',
        description:
            'List the contents of a directory. Use to see what files and directories exist in a folder. If unsure about flags, first run: ls --help',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description:
                        'Directory to list (relative to workspace; omit = current directory)',
                },
            },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'ls', args: ['-1', '{path?}'] },
    },
    {
        name: 'git',
        description:
            'Run a git command inside the workspace repository (status/log/diff/show/grep etc). Use for repository state and history. Prefer read-only commands; if unsure about flags, first run: git --help. Arguments are an array of tokens.',
        parameters: {
            type: 'object',
            properties: {
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'git arguments, one token per array item, e.g. [log, --oneline, -5]',
                },
            },
        },
        minPermission: 'read-only',
        sideEffects: [],
        command: { bin: 'git', args: ['{args?}'] },
    },
    {
        name: 'shell.run',
        description:
            'Run a shell command (bash -lc) inside the workspace: node / npm / pnpm / python / bash, or any script (*.sh, *.js, *.ts, *.py). Use for building, testing, installing dependencies, and executing code. stdout+stderr are returned; long output is truncated. Requires permission ceiling >= draft.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description:
                        'Shell command, executed with cwd = workspace root (e.g. "pnpm install", "node scripts/build.js", "python main.py")',
                },
                timeoutMs: {
                    type: 'number',
                    description: 'Timeout in ms (default 120000, max 600000)',
                },
            },
            required: ['command'],
        },
        minPermission: 'draft',
        irreversible: true,
        sideEffects: ['fs', 'net'],
    },
];
