import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // project-wiki 相关用例要起 git 与 python 子进程，单条耗时 2.5–7s；
        // 默认 5000ms 在满并行（约 198 worker）下会产生假失败，故放宽到 15s。
        testTimeout: 15_000,
        hookTimeout: 15_000,
    },
});
