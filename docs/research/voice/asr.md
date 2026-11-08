# 语音输入 ASR 方案调研（mazi）

> 调研日期：2026-11-08。范围：仅「语音输入识别（ASR）」的选型与集成设计。
> 实现备注（2026-11-08）：P0 最终默认模型改为 52MB 中文轻量 `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23-mobile`（服务启动自动安装）；原 48MB 中英混小模型的 release 归档实际约 437MB，不适合自动安装，中英混模型留作 P1。
> 采信规则：GitHub 数据为当日 API 抓取；模型体积来自官方文档的 `ls -lh` 输出；CER/WER 摘自各自论文/README，跨数据集不可直接比较；无法核实处明确标注「未核实」。

## 0. 结论先行

**推荐链路：浏览器只做采集 → 本机 NestJS → sherpa-onnx（Node addon，CPU 本地推理）两遍识别。**
第一遍用**流式小模型**出 partial（低延迟、低功耗）；第二遍在 finalize 时用**离线大模型**修精度。音频只走 127.0.0.1，默认不出网，零 API key。

| 角色 | 方案 | 一句话理由 |
|---|---|---|
| 首选 | sherpa-onnx Node addon（流式 zipformer 出 partial + 离线模型出 final） | 代码 Apache-2.0、npm 预编译三平台、真流式、纯 Node 依赖，同时满足「实时 partial + 零 Python + 不出公网」 |
| 备选 | sherpa-onnx WASM（浏览器内推理） | 音频连 loopback 都不经过，隐私承诺最强；代价是 wasm+模型下载与跨浏览器内存/SIMD 差异 |
| 降级 | Web Speech API（`processLocally=true`） | 零依赖零体积，但实际只有 Chrome 系可用，zh-CN 语言包可用性未核实；一旦回退云端即违反「默认不上传」 |
| 不选 | whisper.cpp / faster-whisper / transformers.js | 非真流式；中文 CER 明显差（Whisper-large-v3 平均 CER 9.86 vs SenseVoice-L 4.47），体积大或需 Python |
| 不选 | Vosk | 真流式但中文 WER 高（small-cn 23.54），2024-04 后无 release，Node 绑定依赖停更的 ffi-napi |

三个方案都是**免 API key、免费、可离线**；差异在于「谁承担模型分发」和「partial 是否真流式」。

**默认引擎建议**：默认走 **sherpa-onnx 本机流式**（`small-bilingual-zh-en` 48MB 出 partial，离线模型收尾），Web Speech 只作为用户在设置里显式开启的降级项，且必须 `processLocally` 可用，否则隐藏入口。原因：默认路径必须可发版、可回归、可离线、零公网；浏览器原生能力随浏览器/版本差异过大，不能作为默认。「默认开启实时监听」应理解为**默认开启本地流式识别**，不是默认把麦克风音频送去云端。

## 1. mazi 实际约束（已核对代码，非假设）

| 事实 | 出处 | 对选型的约束 |
|---|---|---|
| webui 是纯浏览器 SPA（Vue 3.5 + Vite 8），无 Electron/Tauri shell | `apps/webui/package.json`；全仓无 electron/tauri 依赖 | 麦克风只能由浏览器 `getUserMedia` 采集，后端不能直接抓 mic |
| api 是 NestJS 12 + Fastify 5，已有 SSE 事件通道 | `apps/api/src/events/sse.ts`、`apps/webui/src/scripts/store.ts:625` | SSE 是 GET 单向，不能上行音频；partial 下行可复用其风格，但上行需 WebSocket 或分块 POST |
| Node >= 24、pnpm 10、biome | `package.json` | native addon 需 N-API/Node 24 兼容；pnpm 的 `.pnpm/...` 路径会影响动态库查找 |
| Composer 已有 IME composition 处理与 Enter 提交判定 | `apps/webui/src/components/Composer.vue`（`compositionstart/end`、`shouldSubmitOnEnter`） | 语音结果必须走「受控文本注入」，不能模拟键盘，否则会误提交 |
| 已有 `AudioBlock` 内容类型 | `packages/core/src/provider.ts:84` | 预留了「语音附件」可能，但本方案默认转文本、不落音频 |

由此确定的硬标准（按权重）：① 真流式 partial；② 默认零公网上传；③ 免费/零 key；④ 中文为主、中英混合；⑤ 分发不要求用户装 Python 或编译工具链；⑥ macOS arm64 为主，Windows x64 / Linux x64 次之；⑦ 常驻监听可接受的低 CPU。

## 2. 方案总览

| 方案 | 代码/权重许可 | 形态 | 真流式 partial | 中文质量（可核实） | 体积（int8/实际） | macOS/Win/Linux | 2026-11 活跃 | 结论 |
|---|---|---|---|---|---|---|---|---|
| Web Speech API（含 on-device） | 浏览器内置，免费 | 纯浏览器 | 有 `interimResults` | 未核实（依赖实现） | 0（语言包另计） | Chrome 系✓；Safari 云；Firefox 默认禁用 | 标准推进中 | 降级 |
| sherpa-onnx（Node addon） | 代码 Apache-2.0；权重另核 | 后端进程内 | ✅ chunk 级 | zipformer-large 流式 AISHELL-1 CER 1.75 | 模型 25MB / 48MB / 160MB 起 | ✅ 三平台预编译 | 活跃（15.8k★） | **首选** |
| sherpa-onnx（WASM） | 同上 | 纯浏览器 | ✅ | 同上 | wasm 包约 15MB + 模型 | 现代浏览器 | 活跃 | 备选 |
| FunASR（Python/WS sidecar） | 工具包 MIT；权重单独协议 | Python 服务 | ✅（Paraformer streaming） | Paraformer-Large 平均 CER 4.56 | Paraformer streaming 220M 参数 | Python 三平台 | 活跃（21k★） | 不直选，模型可经 sherpa 用 |
| whisper.cpp | MIT | native/CLI/sidecar | ❌ 滑窗伪流式 | Whisper-large-v3 平均 CER 9.86 | turbo 1.5GiB / q5_0 547MiB | ✅ | 活跃（55k★） | 不选 |
| faster-whisper | MIT（CTranslate2） | Python sidecar | ❌ 分段 | 同 Whisper 系 | 同权重 | ✅ 但需 Python | 活跃（26.6k★） | 不选 |
| Vosk | Apache-2.0 | addon/CLI | ✅ | small-cn WER 23.54、cn 13.98 | 42MB / 1.3GB | ✅ | release 停在 2024-04 | 不选 |
| transformers.js | Apache-2.0 | 纯浏览器 | ❌ 分段 | Whisper 小模型更弱 | HF 在线模型 | 需 WebGPU/WASM | 活跃（16.4k★） | 不选 |
| FireRedASR2 / Qwen3-ASR / Fun-ASR-Nano | Apache-2.0（代码） | 离线 one-pass | ❌ | 中文 SOTA（FireRedASR-AED 平均 3.18） | 0.6B~8.3B 参数 | 需 PyTorch/GPU 或 ONNX | 活跃 | 只作 final 二遍候选 |

### 2.1 隐私 / 支持矩阵：本地离线 vs 浏览器 Web Speech

| 维度 | 本地离线（sherpa-onnx，默认引擎） | Web Speech 默认路径（云端） | Web Speech on-device |
|---|---|---|---|
| 音频是否离开本机 | 否（最多到 127.0.0.1 的本机后端） | **是**，发给浏览器厂商服务 | 否（语言包在本机） |
| 是否需要联网 | 首次下载模型后不需要 | 需要 | 语言包装好后不需要 |
| 费用 / API key | 无 | 无 key，但依赖厂商服务与条款 | 无 |
| partial | 真 chunk 流式（可设计 ~320ms） | `interimResults`，实现黑盒 | `interimResults`，质量受语言包限制 |
| 实现覆盖 | 任意现代浏览器（只做采集） | Chrome、Edge（webkit 前缀）、Safari（云） | 仅实现 `processLocally` 的浏览器：BCD 记 Chrome 139+、Firefox 160（caniuse 标默认禁用） |
| 中文 / 中英混 | 可换模型：中英混 48MB、中文专用 25MB | 由厂商服务决定 | 按 `langs` 选语言包；zh-CN 是否可用 **未核实** |
| 可控性 / 可发版 | 高（版本自持、可回归） | 低（行为随浏览器与服务变化） | 中（受浏览器版本与语言包影响） |
| 失败模式 | addon 崩溃/内存/模型加载失败，可兜底 | 断网即不可用；隐私不合规 | 语言包缺失报 `language-not-supported` |

Web Speech 的默认路径按 MDN 原文会把音频发给 web service；on-device 需 `processLocally=true` + 语言包（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition)）。浏览器覆盖以 [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json) 与 [caniuse](https://caniuse.com/speech-recognition) 为准：Safari 只有 `webkit` 前缀且 `processLocally=false`（只能走云），Firefox 在 caniuse 标注为默认禁用。

## 3. 重点差异

### 3.1 流式 partial 能力（决定「默认实时监听」体验）

| 类型 | 代表 | partial 行为 | 延迟量级 |
|---|---|---|---|
| 真流式（增量编码） | sherpa online-transducer / online-ctc / online-paraformer、Vosk、Web Speech `interimResults` | 每个 chunk 追加/低频修正，文本可稳定累积 | 一个 chunk + 计算，约 0.3–0.8s |
| 滑窗伪流式 | whisper.cpp `whisper-stream`（step 500ms）、faster-whisper 分段、transformers.js 分段 | 整段重解码，partial 会「跳变/重写」，越长越慢 | 0.5–2s，CPU 占用高 |

**chunk 语义（关键数字）**：icefall 文档明确 `--decode-chunk-len` 以「subsampling 前帧数」计，默认 32（即 320ms）；sherpa 模型目录里的 `64`、`96` 子目录就是 chunk 大小，「越大 RTF 越低、延迟越高」。所以 partial 间隔可由 chunk 直接设计在 **320ms–1s**。来源：[icefall streaming 文档](https://icefall.readthedocs.io/en/latest/recipes/Streaming-ASR/librispeech/zipformer_transducer.html)、[sherpa 模型文档](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)。

**两遍识别**是官方推荐做法：小流式模型做 first pass，非流式模型做 second pass（见 [sherpa small online models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/small-online-models.html) 的原文提示）。它同时解决「低延迟」和「中文精度」两个互相拉扯的目标。

### 3.2 中文 CER（同表数字同源，跨数据集不可比）

| 模型 | 数据集 | CER |
|---|---|---|
| FireRedASR-LLM（8.3B） | AISHELL-1/2 + WenetSpeech 平均 | 3.05 |
| FireRedASR-AED（1.1B） | 同上 | 3.18 |
| SenseVoice-L（1.6B） | 同上 | 4.47 |
| Paraformer-Large（0.2B） | 同上 | 4.56 |
| Whisper-large-v3（1.6B） | 同上 | 9.86 |
| sherpa 流式 zipformer-large（2025-06-30 导出） | AISHELL-1 / AISHELL-2 / WenetSpeech test_net | 1.75 / 1.91–4.12 / 8.54 |
| Vosk small-cn-0.22 | SpeechIO-02 / THCHS | 23.54 / 17.15 |
| Vosk cn-0.22 | SpeechIO-02 / THCHS | 13.98 / 7.43 |

来源：[FireRedASR README 评测表](https://github.com/FireRedTeam/FireRedASR)、[icefall multi_zh-hans RESULTS](https://github.com/k2-fsa/icefall/blob/master/egs/multi_zh-hans/ASR/RESULTS.md)、[Vosk models](https://alphacephei.com/vosk/models)。
注：FireRedASR 表的前 5 行是同数据集横评，可直接比较；sherpa 行来自 icefall 各自训练配置，只说明「流式相对离线有 0.3–1.5 个点损失」。

### 3.3 延迟 / RTF

- 延迟 ≈ chunk 时长 + 推理耗时 + 网络（本机 loopback 可忽略）。
- **官方没有给出 2025 产模型的 RTF 数字（未核实）**；可用的弱证据是 sherpa 文档称「所有模型都能在 Raspberry Pi 4 上实时」，说明树莓派级 CPU 可跑，桌面 CPU 余量更大。
- 必须自测，建议指标：first-partial 延迟、partial 更新间隔、final 延迟、RTF（处理时长/音频时长）的 p50/p95，分别在 M 系 mac、x64 Linux、Windows 上跑 100 句中文（含中英混、数字、专名）。

### 3.4 Node 集成方式：native addon vs sidecar vs WASM

| 维度 | native addon（sherpa-onnx-node） | sidecar（sherpa WS server / FunASR runtime） | WASM（浏览器内） |
|---|---|---|---|
| 依赖 | 纯 npm；官方预编译 Linux x64/arm64、macOS x64/arm64、Windows x64，无需编译器/Python | 需管理子进程与端口，FunASR 路线还要 Python | 需 emscripten 构建产物；浏览器需 SIMD/Worker |
| 启动 | 进程内 require；macOS/Linux 需 `DYLD_LIBRARY_PATH`/`LD_LIBRARY_PATH`（pnpm 下路径含 `.pnpm/...`），Windows 自动找 DLL | 独立启动、可先 warmup | 页面内异步加载 wasm+模型 |
| 崩溃域 | 与 API 同进程，addon 崩溃拖垮服务 | 隔离，优于 addon | 崩溃只影响页面 |
| 多客户端 | 每会话一个 recognizer 对象，需显式释放 | 天然多路复用 | 每标签页独立 |
| 升级/分发 | npm 版本即模型运行时；模型单独下载 | 版本双份管理 | 静态资源版本化 |
| 结论 | **首选**（复杂度最低） | 作为 addon 不稳定的兜底 | 隐私最优，作为备选 |

### 3.5 模型/二进制分发体积（决定「用户装完多久能用」）

| 组件 | 体积 | 备注 |
|---|---|---|
| sherpa-onnx-node（npm） | 原生库体积未核实（可选平台包按需安装） | v2.0.1；无编译步骤 |
| sherpa-onnx（WASM npm） | 解包约 15.4MB | nodejs 的 WebAssembly 包装；浏览器场景需自建产物（未核实是否有官方预编译浏览器包） |
| streaming small-ctc-zh-int8-2025-04-01 | **25MB**（单文件） | 仅中文，适合常驻 first pass |
| streaming small-bilingual-zh-en-2023-02-16 | 约 48MB（41M encoder int8 + 3.4M + 3.1M） | 中英混，适合日常输入 |
| streaming zipformer-zh-int8-2025-06-30 | 约 160MB（154M encoder int8） | 中文精度更好，CPU 更高 |
| streaming bilingual-zh-en-2023-02-20 | 约 190MB（174M encoder int8） | 老牌中英混模型 |
| streaming paraformer-bilingual-zh-en | 约 230MB（158M+68M int8） | FunASR 系流式模型，sherpa 可直接跑 |
| streaming zipformer-zh-xlarge-int8 | 726MB | 过重，不建议客户端分发 |
| SenseVoiceSmall / Fun-ASR-Nano-2512 | 234M / 800M 参数（ONNX 体积未核实） | 仅作 final 二遍，按需下载 |
| whisper.cpp large-v3-turbo / q5_0 | 1.5GiB / 547MiB | 对照：非流式且更大 |
| Vosk small-cn / cn | 42MB / 1.3GB | 对照 |

结论：**模型不打进 npm 包/仓库**。首次启用按需下载 + sha256 + 许可展示；常驻只加载 25–48MB 流式模型，final 模型按需冷加载。

### 3.6 维护活跃度（2026-11-08 抓取）

| 仓库 | Stars | 最近 push | 许可 |
|---|---|---|---|
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 15819 | 2026-11-07 | Apache-2.0 |
| [FunASR](https://github.com/modelscope/FunASR) | 20962 | 2026-11-08 | MIT（工具包） |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 55008 | 2026-11-08 | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 26580 | 2026-11-06 | MIT |
| [transformers.js](https://github.com/huggingface/transformers.js) | 16406 | 2026-10-30 | Apache-2.0 |
| [vosk-api](https://github.com/alphacep/vosk-api) | 15235 | 2026-10-15 | Apache-2.0（release 停在 [v0.3.50 / 2024-04](https://github.com/alphacep/vosk-api/releases)） |
| [FireRedASR](https://github.com/FireRedTeam/FireRedASR) | 2014 | 2026-02-25 | Apache-2.0 |
| vosk-browser | 531 | 2025-12-07 | Apache-2.0 |

## 4. Top-3 短名单与推荐

**推荐排序：① sherpa-onnx Node addon（默认引擎）→ ② sherpa-onnx WASM → ③ Web Speech API on-device（仅显式开启）。** 判据：先看「默认路径能否零公网 + 真流式 + 可发版」，再看隐私强度，最后才考虑零依赖。

### 4.1 首选：sherpa-onnx Node addon + 两遍识别

- **组合**：partial 用 `streaming small-ctc-zh-int8`（25MB，纯中文）或 `small-bilingual-zh-en`（48MB，中英混）；final 用 SenseVoiceSmall（多语种 / 中文强）或 Fun-ASR-Nano-2512（zh/en/ja + 方言，sherpa 已有 ONNX 支持）。
- **为什么**：① 代码 Apache-2.0，npm 预编译三平台、零编译零 Python；② 真 chunk 流式，partial 间隔可设计到 ~320ms；③ sherpa 同一运行时还支持 Paraformer / Zipformer / SenseVoice / Fun-ASR-Nano / Qwen3-ASR 等 ONNX 模型，换模型不改集成；④ 允许先上 partial、再补 final 精度，风险可分段上线；⑤ 官方文档称模型可在 Raspberry Pi 4 实时，桌面 CPU 裕度大。
- **关键风险**：流式小模型中文 CER 无公开数据（未核实）；权重许可需逐个核对（SenseVoice/FunASR 权重走自定义协议，非 Apache/MIT）；addon 与 API 同进程，崩溃/内存需兜底；macOS/Linux 动态库路径配置较脆；常驻监听功耗需实测。

### 4.2 备选：sherpa-onnx WASM（浏览器内）

- **为什么**：音频完全不出浏览器，「默认不上传音频」可以写成硬承诺；不需要 WS、端口、后端算力；模型与 addon 同源。
- **代价**：wasm 需 emscripten 构建（是否官方预编译分发未核实）；首用要下 25–160MB 模型；Safari 内存/线程限制、WebGPU 不可依赖；性能低于 native（倍数未核实）。
- **适用**：先在 macOS Chrome/Edge 上做灰度，作为「隐私模式」选项保留。

### 4.3 降级：Web Speech API（on-device 优先，禁止静默云端）

- **用法**：仅当 `SpeechRecognition.available({langs:['zh-CN'], processLocally:true, quality:'dictation'}) === 'available'` 时启用；`'downloadable'` 时调 `install()` 并提示；否则**禁用功能**，绝不回退云端。`interimResults=true` 天然有 partial。
- **依据**：Chrome 139 起 unprefixed 并支持 `processLocally` / `available()` / `install()`（[BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)、[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API#on-device_speech_recognition)）；默认仍走云端并把音频发给服务商（[MDN 原文](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)）。
- **风险**：实际只有 Chrome 系可用（caniuse 标 Firefox 默认禁用、Safari 仅 webkit 前缀且 `processLocally=false`）；桌面端 zh-CN 语言包未核实（Chromium SODA 组件清单含 `cmn-Hans-CN`/`cmn-Hant-TW`，但那是组件级清单，不等于桌面 Web Speech 已开放）；实现行为不可控（Chromium 已有 Windows 端 on-device 识别不触发 result 的 issue）。

### 4.4 明确不选

| 方案 | 排除原因 |
|---|---|
| whisper.cpp / large-v3-turbo | 非真流式（`--step 500` 滑窗），中文明显弱（平均 CER 9.86），模型 547MB–2.9GB |
| faster-whisper | 同上 + 需要 Python 运行时，与 NestJS 分发冲突 |
| transformers.js | 浏览器 Whisper 属演示级，非流式、长句延迟高、模型需在线拉取 |
| Vosk | 真流式但中文 WER 23.54 / 13.98；2024 年后无 release；Node 绑定靠 `ffi-napi`（2024-08 后停更，Node 24 风险高） |
| FunASR 直跑 Python | 引入完整 Python 栈与 CUDA 依赖；其模型可经 sherpa-onnx ONNX 使用，不必接受该成本 |
| FireRedASR2 / 大模型 one-pass | 中文 SOTA 但非流式、参数 1.1B–8.3B，不适合实时输入；可作为 final 二遍候选 |

## 5. 与 mazi 的落点（设计层，不写实现）

**前端（apps/webui）**
1. `Composer.vue` 增加 mic 按钮与录音态；partial 以灰色 ghost text 叠加显示，final 通过 `emit('update:modelValue', ...)` 受控注入，**不要**模拟键盘事件（避免触发 `shouldSubmitOnEnter` 与 IME 组合态）。
2. 采集：`getUserMedia` → `AudioWorklet` → 重采样 16kHz/mono/Int16 → 每 32–100ms 一帧。
3. 默认监听：仅「页面可见 + 用户已开启 + 未在播放音频」时开麦；首层用能量/RMS VAD 门控，空闲期不上行，降低 CPU 与隐私风险；提供明显的一键暂停。
4. 失败降级：WS 断开或后端 ASR 不可用时，退化到「按住说话 + 结束时一次性上传」，保持可用。

**后端（apps/api）**
1. 新增 voice 模块 + WS gateway（`@nestjs/platform-ws` 当前 latest 为 12.4.0，与 NestJS 12 对齐），路由如 `/voice/stream`：二进制帧进、JSON partial 出；SSE 现网通道不动。
2. 每会话一个 recognizer 状态机：idle → listening → finalizing；断线/超时/切会话必须 `close()`，避免 addon 对象泄漏。
3. 兜底：若 addon 在生产上出现崩溃或内存问题，切 sherpa-onnx 自带 WS server 作为 sidecar（Node 侧只做鉴权与转发）。
4. 文本落地后复用现有 conversation/session 流程；不改 provider 抽象；默认不保存原始音频（要保存时用已有 `AudioBlock`）。

**模型管理**
1. 首次启用时下载到用户数据目录（macOS `~/Library/Application Support/mazi/models`、Linux/Windows 对应目录），展示体积与许可，sha256 校验，离线复用。
2. 两级加载：常驻 25–48MB 流式模型；final 模型（SenseVoiceSmall / Fun-ASR-Nano）只在 finalize 时冷加载或按内存开关。
3. 模型版本与运行时版本绑定校验（避免导出格式升级导致加载失败）。

## 6. 风险与未核实清单

| 事项 | 状态 | 验证方式 |
|---|---|---|
| 桌面 Chrome on-device 是否支持 zh-CN 语言包 | **未核实**（SODA 组件清单含 cmn-Hans-CN，但桌面 Web Speech 实际开放情况未证实） | Chrome 155 实机跑 `available()/install()` + 中文识别 |
| Firefox 160 的 SpeechRecognition 是否可用 | **未核实**（BCD 记 160，caniuse 标默认禁用） | 实机检测 + about:config |
| sherpa 流式模型 RTF / 首字/partial 延迟 | **未核实**（官方无 2025 产模型数字） | 自建 benchmark：RTF、first-partial、更新间隔、final 延迟 p50/p95 |
| 流式小模型中文 CER | **未核实** | 100 句中文与中英混测试集，人工 + CER 脚本 |
| 各模型权重许可 | **部分未核实** | 逐个 model card；注意 SenseVoice 权重走 [FunASR 模型开源协议](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)（非 Apache/MIT），官方澄清可商用但需署名 |
| sherpa WASM 是否有官方预编译产物 | **未核实** | 查 release assets；否则自建 emscripten CI |
| Node 24 + addon ABI 兼容 | **未核实**（N-API 理论兼容） | 三平台 CI 冒烟测试 |
| 常驻监听 CPU/内存/功耗 | **未核实** | 1h 空转 + 1h 对话实测 RSS/CPU/电量 |
| 静音误触发、扬声器回声自激 | **未核实** | VAD 阈值 + 播放音频期间 gate 联调 |

## 7. 参考资料

- Web Speech 标准/实现：[BCD SpeechRecognition](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)、[MDN 使用指南](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)、[MDN available()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/available_static)、[on-device explainer](https://github.com/webaudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)、[Chrome 150 演示](https://chrome-platform-showcase.paulkinlan-ea.deno.net/v150/on-device-web-speech-api/feature-detection-and-setup/)、[SODA 语言清单源码](https://chromium.googlesource.com/chromium/src/+/main/components/soda/soda_installer.cc)、[caniuse](https://caniuse.com/speech-recognition)
- sherpa-onnx：[仓库](https://github.com/k2-fsa/sherpa-onnx)、[Node 安装（预编译平台）](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)、[Node 示例](https://github.com/k2-fsa/sherpa-onnx/tree/master/nodejs-addon-examples)、[在线模型](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html)、[small 模型](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/small-online-models.html)、[WASM](https://k2-fsa.github.io/sherpa/onnx/wasm/index.html)、[WebSocket](https://k2-fsa.github.io/sherpa/onnx/websocket/index.html)、[Fun-ASR-Nano](https://k2-fsa.github.io/sherpa/onnx/funasr-nano/index.html)、[Qwen3-ASR](https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/index.html)、[npm](https://www.npmjs.com/package/sherpa-onnx-node)
- 中文模型评测：[FireRedASR](https://github.com/FireRedTeam/FireRedASR) / [论文](https://arxiv.org/abs/2501.14350)、[icefall multi_zh-hans RESULTS](https://github.com/k2-fsa/icefall/blob/master/egs/multi_zh-hans/ASR/RESULTS.md)、[icefall streaming chunk 说明](https://icefall.readthedocs.io/en/latest/recipes/Streaming-ASR/librispeech/zipformer_transducer.html)
- FunASR / SenseVoice：[FunASR](https://github.com/modelscope/FunASR)、[模型协议](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)、[SenseVoice](https://github.com/FunAudioLLM/SenseVoice)、[权重许可澄清](https://github.com/QwenAudio/SenseVoice/issues/334)、[论文](https://arxiv.org/abs/2407.04051)
- 对照方案：[whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [模型体积](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md) / [stream 示例](https://github.com/ggml-org/whisper.cpp/blob/master/examples/stream/README.md)、[faster-whisper](https://github.com/SYSTRAN/faster-whisper)、[Vosk models](https://alphacephei.com/vosk/models) / [releases](https://github.com/alphacep/vosk-api/releases) / [vosk npm](https://www.npmjs.com/package/vosk) / [ffi-napi](https://github.com/node-ffi-napi/node-ffi-napi)、[transformers.js](https://github.com/huggingface/transformers.js) / [whisper-web](https://github.com/xenova/whisper-web)
- mazi 代码锚点：`apps/webui/src/components/Composer.vue`、`apps/webui/src/scripts/store.ts`、`apps/api/src/events/sse.ts`、`packages/core/src/provider.ts`
