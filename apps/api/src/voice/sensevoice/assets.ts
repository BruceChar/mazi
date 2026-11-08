import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * DSH 固定的 SenseVoice 离线转写模型（SenseVoiceSmall int8 + Silero VAD）。
 *
 * 资产直接取自 DSH 的 speech-to-text 缓存；版本固定为以下 commit：
 * https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07
 * https://huggingface.co/csukuangfj/vad/tree/fba88cd2e921609e7675c3aaf51e0b9b295da4bc
 */
export const SENSEVOICE_MODEL_ID = 'sensevoice-small-int8';

export const SENSEVOICE_MODEL_NAME = 'SenseVoice Small（整段离线转写）';

export const SENSEVOICE_MODEL_DESCRIPTION =
    'SenseVoiceSmall int8 + Silero VAD，整段录音结束后一次性离线转写，支持中文、英文、粤语、日语、韩语。';

export const SENSEVOICE_LANGUAGES: readonly string[] = ['zh', 'en', 'yue', 'ja', 'ko'];

/** 模型许可（权重与 tokens 继承 SenseVoice 模型卡；Silero VAD 为 MIT）。 */
export const SENSEVOICE_LICENSE = 'Apache-2.0';

export const SENSEVOICE_LICENSE_URL =
    'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

/** 模型目录环境变量（覆盖 DSH 缓存与默认目录）。 */
export const SENSEVOICE_MODEL_DIR_ENV = 'MAZI_VOICE_SENSEVOICE_DIR';

/**
 * child 进程读取模型路径的环境变量。
 * 由 host 在 fork 时注入（非用户配置），避免把 239MB 路径塞进 IPC 请求。
 */
export const SENSEVOICE_MODEL_PATH_ENV = 'MAZI_VOICE_SENSEVOICE_MODEL_PATH';
export const SENSEVOICE_TOKENS_PATH_ENV = 'MAZI_VOICE_SENSEVOICE_TOKENS_PATH';
export const SENSEVOICE_VAD_PATH_ENV = 'MAZI_VOICE_SENSEVOICE_VAD_PATH';

export type SenseVoiceAssetKind = 'model' | 'tokens' | 'vad';

export interface SenseVoiceAsset {
    kind: SenseVoiceAssetKind;
    /** 模型目录内的文件名。 */
    fileName: string;
    url: string;
    sizeBytes: number;
    sha256: string;
}

/** 固定资产清单（顺序即下载顺序；总量 ≈ 241MB）。 */
export const SENSEVOICE_ASSETS: readonly SenseVoiceAsset[] = [
    {
        kind: 'model',
        fileName: 'model.int8.onnx',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
        sizeBytes: 239_233_841,
        sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    },
    {
        kind: 'tokens',
        fileName: 'tokens.txt',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
        sizeBytes: 315_894,
        sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    },
    {
        kind: 'vad',
        fileName: 'silero_vad.onnx',
        url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
        sizeBytes: 1_807_522,
        sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
    },
];

/** 默认文件名（DSH 缓存目录布局固定使用这些名字）。 */
export const SENSEVOICE_FILES: Readonly<Record<SenseVoiceAssetKind, string>> = {
    model: 'model.int8.onnx',
    tokens: 'tokens.txt',
    vad: 'silero_vad.onnx',
};

export const SENSEVOICE_TOTAL_SIZE_BYTES = SENSEVOICE_ASSETS.reduce(
    (total, asset) => total + asset.sizeBytes,
    0,
);

/**
 * 模型目录：MAZI_VOICE_SENSEVOICE_DIR > $MAZI_HOME/voice/models/<id>。
 * 通用用户没有 DSH 缓存时才需要下载到这里。
 */
export function defaultSenseVoiceModelDir(env: NodeJS.ProcessEnv = process.env): string {
    const override = env[SENSEVOICE_MODEL_DIR_ENV]?.trim();
    if (override) return resolve(expandHomePath(override));
    const home = env.MAZI_HOME?.trim();
    const maziHome = home && home.length > 0 ? expandHomePath(home) : join(homedir(), '.mazi');
    return resolve(join(maziHome, 'voice', 'models', SENSEVOICE_MODEL_ID));
}

/** 展开前导 ~（与 model-manager / runtime 的约定一致）。 */
export function expandHomePath(value: string): string {
    if (value === '~') return homedir();
    if (value.startsWith('~/')) return join(homedir(), value.slice(2));
    return value;
}
