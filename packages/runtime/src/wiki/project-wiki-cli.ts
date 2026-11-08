#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import { ProjectWikiService } from './project-wiki.js';

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    if (args[0] === '--version') {
        process.stdout.write('project-wiki runtime 1.0.0\n');
        return;
    }
    if (args[0] === 'setup-env') {
        try {
            const version = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
            process.stdout.write(`✓ ${version}\n`);
            return;
        } catch {
            process.stderr.write('✗ 未检测到 git，请先安装 Git\n');
            process.exitCode = 2;
            return;
        }
    }
    const service = new ProjectWikiService({ workspace: process.cwd() });
    try {
        const result = await service.runCommand(args);
        if (result.content) process.stdout.write(`${result.content}\n`);
        process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
        process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
    }
}

void main();
