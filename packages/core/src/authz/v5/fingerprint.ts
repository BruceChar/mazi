/**
 * V5 指纹（§8/D14）：归一化命令行 + 目标绑定 + 内容哈希。
 *
 * 指纹只解决"完全相同的重复"，不做任何泛化：写法歧义（flag 顺序、引号变体
 * 之外的差异）即新指纹。执行类绑脚本内容哈希，envelope 类绑目标文件内容哈希，
 * 被绑对象改动即失效。
 */

export interface FingerprintInput {
    /** 归一化前的命令行；空白压缩与引号等价在此处理。 */
    command?: string;
    /** 目标绑定：host / 收件人 / 分支+远端 / 路径。 */
    targetBinding?: string;
    /** 内容哈希：执行类脚本哈希 / envelope 目标文件哈希。 */
    contentHash?: string;
}

/** 空白压缩 + 首尾成对引号去除；不做 flag 重排等价（歧义即新指纹）。 */
export function normalizeCommand(command: string): string {
    return command
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^(["'])(.*)\1$/, '$2');
}

/** 稳定指纹 key；任一部分缺失则省略该段。 */
export function fingerprintKey(input: FingerprintInput): string {
    const parts = [
        input.command ? `cmd:${normalizeCommand(input.command)}` : '',
        input.targetBinding ? `tgt:${input.targetBinding}` : '',
        input.contentHash ? `hash:${input.contentHash}` : '',
    ].filter(Boolean);
    return parts.join('|');
}
