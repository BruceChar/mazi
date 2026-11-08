import type { VoiceInstallStatus, VoiceModelInfo } from '@mazi/libs';

export interface VoiceModelFileSpec {
    /** 归档解压后用于定位文件的 glob（简单 * 匹配）。 */
    pattern: string;
    /** 是否必需。 */
    required: boolean;
}

export interface VoiceModelDefinition {
    id: string;
    name: string;
    description: string;
    languages: string[];
    sizeBytes: number;
    license: string;
    licenseUrl?: string;
    /** tar.bz2 归档下载地址（固定白名单）。 */
    url: string;
    /** 解压后必须存在的文件匹配（相对模型目录）。 */
    files: VoiceModelFileSpec[];
    recommended: boolean;
}

/**
 * 模型注册表。
 *
 * 约束：模型不进仓库/npm；首次启用经 ModelManager 下载到
 * $MAZI_HOME/voice/models/<id>/，sha256 记录在 models.json。
 * 默认模型只选可商用许可的权重；新增模型前必须核对 model card。
 */
export const VOICE_MODELS: readonly VoiceModelDefinition[] = [
    // 旧版已安装模型：保留注册，避免升级后把用户本地已有模型判为未安装。
    {
        id: 'sherpa-streaming-small-bilingual-zh-en',
        name: '中英混合流式模型（旧版，已安装优先使用）',
        description: 'sherpa-onnx streaming zipformer small bilingual zh-en；本机已有安装时直接使用。',
        languages: ['zh', 'en'],
        sizeBytes: 458_187_351,
        license: 'Apache-2.0',
        licenseUrl: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2',
        files: [
            { pattern: '*encoder*.onnx', required: true },
            { pattern: '*decoder*.onnx', required: true },
            { pattern: '*joiner*.onnx', required: true },
            { pattern: 'tokens.txt', required: true },
        ],
        recommended: false,
    },
    {
        id: 'sherpa-streaming-zipformer-zh-14m-mobile',
        name: '中文流式模型（轻量）',
        description: 'sherpa-onnx streaming zipformer zh 14M mobile，中文实时识别，适合首次自动安装。',
        languages: ['zh'],
        sizeBytes: 54_344_380,
        license: 'Apache-2.0',
        licenseUrl: 'https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23-mobile.tar.bz2',
        files: [
            { pattern: '*encoder*.onnx', required: true },
            { pattern: '*decoder*.onnx', required: true },
            { pattern: '*joiner*.onnx', required: true },
            { pattern: 'tokens.txt', required: true },
        ],
        recommended: true,
    },
];

export function findVoiceModel(id: string): VoiceModelDefinition | undefined {
    return VOICE_MODELS.find((model) => model.id === id);
}

/** ModelManager 对 VoiceService 暴露的最小接口（可替换为测试 fake）。 */
export interface VoiceModelStore {
    list(): VoiceModelInfo[];
    installed(id: string): boolean;
    modelDir(id: string): string;
    startDownload(id: string): { jobId: string };
    downloadStatus(
        jobId: string,
    ): { status: 'running' | 'done' | 'error'; progress: number; error?: string } | undefined;
    remove?(id: string): void;
    /** 服务启动时自动安装默认模型的进度；未启用/未开始时返回 undefined。 */
    autoInstallStatus?(): VoiceInstallStatus | undefined;
}

export function voiceModelInfo(model: VoiceModelDefinition, installed: boolean): VoiceModelInfo {
    return {
        id: model.id,
        name: model.name,
        description: model.description,
        languages: model.languages,
        sizeBytes: model.sizeBytes,
        license: model.license,
        licenseUrl: model.licenseUrl,
        installed,
        recommended: model.recommended,
    };
}
