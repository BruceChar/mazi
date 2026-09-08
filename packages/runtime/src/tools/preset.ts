/**
 * BUILTIN_TOOL_PRESET - built-in CLI tool preset.
 *
 * Replaces the former "fs.read only" situation so the model can inspect a project
 * structure and contents efficiently (rg/fd/bat/eza/dua/difft/xh/sd/sg).
 * Every CLI tool runs inside the workspace as argv (no shell) via the generic
 * command runner; a missing binary is auto-installed (see CliCommandSpec.installPackage)
 * and the call is retried once. Config-layer tools with the same name override these.
 */
import type { ToolConfig } from '../config.js';

export const BUILTIN_TOOL_PRESET: ToolConfig[] = [
    {
        name: 'fs.read',
        description:
            'Read a single file inside the workspace (utf8). Use when you need the exact file body; for discovery/search prefer rg/fd/bat first.',
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
            'Search file contents with ripgrep (regex, ~5-20x faster than grep; skips .gitignore and binary files; outputs JSON). Use to locate references/definitions/symbols while analyzing a project instead of reading files one by one.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Regex search pattern' },
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
            'Find files/directories with fd (regex/glob, ~2-8x faster than find; ignores hidden and gitignored entries by default; outputs JSON). Use to map the project structure and file names.',
        parameters: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: 'Filename glob or regex (omit to list everything)',
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
        command: { bin: 'fd', args: ['--json', '{pattern?}', '{path?}'], installPackage: 'fd' },
    },
    {
        name: 'bat',
        description:
            'View a single file with line numbers and syntax highlighting (plain output here). Use instead of cat to read one file precisely.',
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
            'Modern directory listing (ls replacement) with file/dir separation; pass a directory to list it. Use to quickly inspect a directory structure.',
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
            args: ['--color', 'never', '--all', '--group-directories-first', '{path?}'],
            installPackage: 'eza',
        },
    },
    {
        name: 'dua',
        description:
            'Disk usage analyzer (dua-cli). Interactive in a TTY; when run non-interactively it may error out - use it to find big directories, or prefer fd/eza for structure.',
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
            'Semantic/AST diff between two files (understands code moves, not just text). Use to compare two versions of a file.',
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
            'Modern HTTP client (GET/POST with clean JSON output). NOTE: performs real network requests; use only when the task requires remote data.',
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
            'Simple string/regex replacement in files (WRITES files). Read the file first to confirm before editing.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Pattern to find (literal or regex)' },
                replacement: { type: 'string', description: 'Replacement string' },
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
            'ast-grep (sg): search/rewrite code by syntax tree (JSON output) - understands real structure, not just strings. Use to find/refactor code patterns.',
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
];
