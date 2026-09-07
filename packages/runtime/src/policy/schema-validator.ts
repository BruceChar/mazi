/** 校验结果：path 指向被校验值的路径，message 为中文违规描述 */
export interface ValidationIssue {
    path: string;
    message: string;
}

/**
 * mini JSON-Schema 子集校验器（MVP §8 F7 / D4，不引入 TypeBox）。
 * 支持子集：object{type,properties,required,additionalProperties}、array{type,items}、
 * string{minLength,maxLength,pattern}、number{minimum,maximum}、boolean，以及任意层 enum。
 * fail-closed：未声明支持的 type、或出现子集外关键字时输出 issue（不抛异常）。
 */

const SUPPORTED_TYPES = ['object', 'array', 'string', 'number', 'boolean'] as const;
type SupportedType = (typeof SUPPORTED_TYPES)[number];

/** 各 type 分支额外支持的关键字（type/enum 为任意节点通用） */
const BRANCH_KEYWORDS: Record<SupportedType, ReadonlySet<string>> = {
    object: new Set(['properties', 'required', 'additionalProperties']),
    array: new Set(['items']),
    string: new Set(['minLength', 'maxLength', 'pattern']),
    number: new Set(['minimum', 'maximum']),
    boolean: new Set(),
};

function describeValue(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
}

/** JSON 值深度相等（enum 匹配用；不支持 NaN，JSON 值域内无此问题） */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== typeof b || a === null || b === null) {
        return false;
    }
    if (typeof a !== 'object') {
        return false;
    }
    const aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) {
        return false;
    }
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    if (aKeys.length !== Object.keys(bObj).length) {
        return false;
    }
    for (const key of aKeys) {
        if (!hasOwn(bObj, key) || !deepEqual(aObj[key], bObj[key])) {
            return false;
        }
    }
    return true;
}

/** enum 断言：值必须深度等于允许集合中的某一项 */
function checkEnum(
    enumValue: unknown,
    value: unknown,
    path: string,
    issues: ValidationIssue[],
): void {
    if (!Array.isArray(enumValue)) {
        issues.push({ path, message: 'enum 必须是数组' });
        return;
    }
    if (!enumValue.some((item) => deepEqual(item, value))) {
        issues.push({
            path,
            message: `值不在 enum 允许集合内（允许 ${JSON.stringify(enumValue)}）`,
        });
    }
}

function childPath(path: string, key: string): string {
    return path === '$' ? `$.${key}` : `${path}.${key}`;
}

/**
 * 递归校验单个 schema 节点。
 * 约定：任一节点必须先能判定"自身受支持"，否则直接产出 issue 并停止该节点（fail-closed）。
 */
function checkNode(schema: unknown, value: unknown, path: string, issues: ValidationIssue[]): void {
    if (!isPlainObject(schema)) {
        issues.push({
            path,
            message: `schema 节点必须是对象，实际为 ${describeValue(schema)}（不支持 boolean/数组/裸值 schema）`,
        });
        return;
    }
    const declaredType = schema.type;
    // 无 type：仅支持空 schema（无约束放行）与纯 { enum } 节点
    if (declaredType === undefined) {
        const extras = Object.keys(schema).filter((key) => key !== 'enum');
        if (extras.length === 0) {
            if (hasOwn(schema, 'enum')) {
                checkEnum(schema.enum, value, path, issues);
            }
            return;
        }
        issues.push({
            path,
            message: `schema 节点缺少受支持的 type（仅支持显式 type 或纯 { enum }，发现未知关键字：${extras.join(', ')}）`,
        });
        return;
    }
    if (
        typeof declaredType !== 'string' ||
        !SUPPORTED_TYPES.includes(declaredType as SupportedType)
    ) {
        issues.push({
            path,
            message: `不支持的 type：${JSON.stringify(declaredType)}（仅支持 object/array/string/number/boolean）`,
        });
        return;
    }
    const type = declaredType as SupportedType;
    // 未知关键字检查：出现在子集之外即 fail-closed（先于值校验，命中即止）
    const unknownKeys = Object.keys(schema).filter(
        (key) => key !== 'type' && key !== 'enum' && !BRANCH_KEYWORDS[type].has(key),
    );
    if (unknownKeys.length > 0) {
        issues.push({
            path,
            message: `未知关键字 ${unknownKeys.map((k) => `'${k}'`).join(', ')} 不被支持（type='${type}'）`,
        });
        return;
    }
    // 值类型断言
    const typeMatches =
        (type === 'object' && isPlainObject(value)) ||
        (type === 'array' && Array.isArray(value)) ||
        (type === 'string' && typeof value === 'string') ||
        (type === 'number' && typeof value === 'number') ||
        (type === 'boolean' && typeof value === 'boolean');
    if (!typeMatches) {
        issues.push({ path, message: `期望 type='${type}'，实际为 ${describeValue(value)}` });
        return;
    }
    // 分支关键字
    switch (type) {
        case 'object': {
            const obj = value as Record<string, unknown>;
            const properties = schema.properties;
            if (properties !== undefined) {
                if (!isPlainObject(properties)) {
                    issues.push({ path, message: 'properties 必须是对象（key → schema）' });
                } else {
                    for (const [propKey, propSchema] of Object.entries(properties)) {
                        if (hasOwn(obj, propKey)) {
                            checkNode(propSchema, obj[propKey], childPath(path, propKey), issues);
                        }
                    }
                }
            }
            const required = schema.required;
            if (required !== undefined) {
                if (
                    !Array.isArray(required) ||
                    !required.every((item) => typeof item === 'string')
                ) {
                    issues.push({ path, message: 'required 必须是字符串数组' });
                } else {
                    for (const req of required as string[]) {
                        if (!hasOwn(obj, req)) {
                            issues.push({ path, message: `缺少必填属性 '${req}'` });
                        }
                    }
                }
            }
            const additionalProperties = schema.additionalProperties;
            if (additionalProperties !== undefined) {
                if (typeof additionalProperties !== 'boolean') {
                    issues.push({
                        path,
                        message: 'additionalProperties 仅支持 boolean（schema 对象形式不在子集内）',
                    });
                } else if (additionalProperties === false) {
                    const known = new Set(
                        Object.keys((properties as Record<string, unknown>) ?? {}),
                    );
                    for (const key of Object.keys(obj)) {
                        if (!known.has(key)) {
                            issues.push({
                                path: childPath(path, key),
                                message: '额外属性不允许（additionalProperties=false）',
                            });
                        }
                    }
                }
            }
            break;
        }
        case 'array': {
            const arr = value as unknown[];
            const items = schema.items;
            if (items !== undefined) {
                if (!isPlainObject(items)) {
                    issues.push({
                        path,
                        message: 'items 仅支持单一 schema 对象（tuple 数组形式不在子集内）',
                    });
                } else {
                    for (let i = 0; i < arr.length; i++) {
                        checkNode(items, arr[i], `${path}[${i}]`, issues);
                    }
                }
            }
            break;
        }
        case 'string': {
            const str = value as string;
            const minLength = schema.minLength;
            if (minLength !== undefined) {
                if (typeof minLength !== 'number') {
                    issues.push({ path, message: 'minLength 必须是数字' });
                } else if ([...str].length < minLength) {
                    issues.push({
                        path,
                        message: `字符串长度 ${[...str].length} 小于 minLength ${minLength}`,
                    });
                }
            }
            const maxLength = schema.maxLength;
            if (maxLength !== undefined) {
                if (typeof maxLength !== 'number') {
                    issues.push({ path, message: 'maxLength 必须是数字' });
                } else if ([...str].length > maxLength) {
                    issues.push({
                        path,
                        message: `字符串长度 ${[...str].length} 大于 maxLength ${maxLength}`,
                    });
                }
            }
            const pattern = schema.pattern;
            if (pattern !== undefined) {
                if (typeof pattern !== 'string') {
                    issues.push({ path, message: 'pattern 必须是字符串' });
                } else {
                    try {
                        const regex = new RegExp(pattern);
                        if (!regex.test(str)) {
                            issues.push({ path, message: `字符串不匹配 pattern '${pattern}'` });
                        }
                    } catch {
                        issues.push({ path, message: `pattern '${pattern}' 不是合法正则表达式` });
                    }
                }
            }
            break;
        }
        case 'number': {
            const num = value as number;
            const minimum = schema.minimum;
            if (minimum !== undefined) {
                if (typeof minimum !== 'number') {
                    issues.push({ path, message: 'minimum 必须是数字' });
                } else if (num < minimum) {
                    issues.push({ path, message: `数值 ${num} 小于 minimum ${minimum}` });
                }
            }
            const maximum = schema.maximum;
            if (maximum !== undefined) {
                if (typeof maximum !== 'number') {
                    issues.push({ path, message: 'maximum 必须是数字' });
                } else if (num > maximum) {
                    issues.push({ path, message: `数值 ${num} 大于 maximum ${maximum}` });
                }
            }
            break;
        }
        case 'boolean':
            break;
    }
    // enum 可与 type 同层出现：值通过类型断言后仍需命中允许集合
    if (hasOwn(schema, 'enum')) {
        checkEnum(schema.enum, value, path, issues);
    }
}

/**
 * 校验 value 是否符合 schema。
 * 返回全部违规 issue；schema 合法且 value 合规时返回空数组。任何输入均不抛异常。
 */
export function validateSchema(schema: unknown, value: unknown): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    checkNode(schema, value, '$', issues);
    return issues;
}
