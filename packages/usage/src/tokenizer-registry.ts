/** 文本 → token 数的估算器抽象（结构性接口，可传入任意 { estimate } 实现） */
export interface TextEstimator {
    /** 估算 text 的 token 数 */
    estimate(text: string): number;
}

/**
 * 默认估算器：按字符数估算 token（charsPerToken 个字符算 1 token，向上取整）。
 * MVP v1.0 §5.2 口径默认 char/4；真实厂商 tokenizer 上线后按厂商替换/注册。
 */
export class TokenEstimator implements TextEstimator {
    private readonly charsPerToken: number;

    constructor(charsPerToken = 4) {
        // 非法（<=0）入参按 1 处理，避免除零得到 Infinity
        this.charsPerToken = charsPerToken > 0 ? charsPerToken : 1;
    }

    estimate(text: string): number {
        if (text.length === 0) {
            return 0;
        }
        return Math.ceil(text.length / this.charsPerToken);
    }
}

/**
 * 厂商 tokenizer 注册表：按厂商名注册估算器；
 * 未指定厂商或厂商未注册时回退默认估算器（chars/4，MVP 不自动切换 tokenizer）。
 */
export class TokenizerRegistry {
    private readonly estimators = new Map<string, TextEstimator>();
    private readonly fallback: TextEstimator;

    constructor(fallback: TextEstimator = new TokenEstimator()) {
        this.fallback = fallback;
    }

    /** 注册某厂商的估算器；同名厂商覆盖旧实现 */
    register(vendor: string, estimator: TextEstimator): void {
        this.estimators.set(vendor, estimator);
    }

    /** 估算一段文本：vendor 已注册用其估算器，否则用默认估算器 */
    estimate(text: string, vendor?: string): number {
        const estimator = vendor === undefined ? undefined : this.estimators.get(vendor);
        return (estimator ?? this.fallback).estimate(text);
    }

    /** 按 sections 逐段估算，保留原 key（各段独立计数，供 ContextMeter 分段统计） */
    count(sections: Record<string, string>, vendor?: string): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [key, text] of Object.entries(sections)) {
            result[key] = this.estimate(text, vendor);
        }
        return result;
    }
}
