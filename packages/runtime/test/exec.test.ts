import { describe, expect, it } from 'vitest';

import { runcli } from '../src/tools/exec';

describe('runcli', () => {
    it('returns stdout and stderr as strings', async () => {
        const result = await runcli(process.execPath, [
            '-e',
            "process.stdout.write('hello'); process.stderr.write('warning');",
        ]);

        expect(result).toEqual({ stdout: 'hello', stderr: 'warning' });
    });

    it('passes cwd and env options to the child process', async () => {
        const result = await runcli(
            process.execPath,
            ['-e', "process.stdout.write(process.cwd() + ':' + process.env.RUNCLI_TEST)"],
            { cwd: process.cwd(), env: { ...process.env, RUNCLI_TEST: 'enabled' } },
        );

        expect(result).toEqual({ stdout: `${process.cwd()}:enabled`, stderr: '' });
    });

    it('wraps execution errors with the command and original error', async () => {
        const args = ['-e', "process.stderr.write('boom'); process.exit(1)"];

        const promise = runcli(process.execPath, args);

        await expect(promise).rejects.toThrow(
            `Failed to execute command: ${process.execPath} ${args.join(' ')}`,
        );
        await expect(promise).rejects.toThrow('Error:');
    });
});
