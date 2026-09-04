/**
 * 轻量 ULID 生成器（core 内唯一运行时工具，零外部依赖，仅用 Node 内置模块）。
 * 满足 v1.2 对 sessionId/turnId/stepId/eventId 的 ULID 要求：
 * 48 位毫秒时间戳前缀（字典序可排序）+ 80 位随机后缀，Crockford Base32 编码，共 26 字符。
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10; // 48bit / 5bit = 10 chars
const RANDOM_LEN = 16; // 80bit / 5bit = 16 chars
let lastTime = 0;

/** 时间戳部分：单调递增，保证同一毫秒内多次生成仍严格有序 */
function encodeTime(now: number): string {
    let time = now;
    if (time <= lastTime) {
        time = lastTime + 1;
    }
    lastTime = time;
    const chars = new Array<string>(TIME_LEN);
    for (let i = TIME_LEN - 1; i >= 0; i--) {
        chars[i] = ENCODING[time % 32];
        time = Math.floor(time / 32);
    }
    return chars.join('');
}

/** 随机部分：256 % 32 === 0，无取模偏差 */
function encodeRandom(): string {
    const bytes = randomBytes(RANDOM_LEN);
    const chars = new Array<string>(RANDOM_LEN);
    for (let i = 0; i < RANDOM_LEN; i++) {
        chars[i] = ENCODING[bytes[i] % 32];
    }
    return chars.join('');
}

/** 生成一个 26 字符 ULID */
export function ulid(): string {
    return encodeTime(Date.now()) + encodeRandom();
}
