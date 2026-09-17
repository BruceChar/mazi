/**
 * Lightweight ULID(Universally Unique Lexicographically Sortable Identifier) generator.
 * Zero external dependencies; uses only Node.js built-in modules.
 *
 * Generates 26-character identifiers compliant with Crockford Base32 encoding:
 * - Prefix: 48-bit millisecond timestamp (ensures lexicographical sortability).
 * - Suffix: 80-bit cryptographically secure random data.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford's Base32 character set
const TIME_LEN = 10; // 48 bits / 5 bits per char = 10 chars
const RANDOM_LEN = 16; // 80 bits / 5 bits per char = 16 chars
let lastTime = 0; // Tracks the last generated timestamp to enforce monotonicity

declare const Phantom: unique symbol;
type PhantomTag<T> = { readonly [Phantom]: T };

/**
 * A branded type for ULID strings to ensure type safety.
 */
export type ULID = string & PhantomTag<'ULID'>;

/**
 * Encodes the timestamp portion of the ULID.
 * Guarantees strict monotonicity, ensuring that multiple IDs generated within
 * the same millisecond are strictly ordered by incrementing the timestamp.
 *
 * @param now - The current time in milliseconds.
 * @returns A 10-character Base32 string representing the timestamp.
 */
function encodeTime(now: number): string {
    let time = now;
    // If the clock hasn't moved forward, increment the time to maintain monotonicity
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

/**
 * Encodes the random portion of the ULID.
 * Uses cryptographically secure random bytes. Since 256 is evenly divisible by 32,
 * the modulo operation introduces no statistical bias.
 *
 * @returns A 16-character Base32 string representing the random data.
 */
function encodeRandom(): string {
    const bytes = randomBytes(RANDOM_LEN);
    const chars = new Array<string>(RANDOM_LEN);
    for (let i = 0; i < RANDOM_LEN; i++) {
        chars[i] = ENCODING[bytes[i] % 32];
    }
    return chars.join('');
}

/**
 * Generates a 26-character ULID.
 * The resulting string is a combination of a monotonic timestamp and a random suffix.
 *
 * @returns A unique, monotonically increasing ULID.
 */
export function ulid(): ULID {
    return (encodeTime(Date.now()) + encodeRandom()) as ULID;
}
