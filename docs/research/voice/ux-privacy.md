# 语音输入：UX / 隐私 / 浏览器约束调研

> 版本：v0.2（调研稿）· 日期：2026-11-08 · 范围：仅"语音输入"（ASR + 交互 + 隐私 + 降级）；ASR 引擎选型见同目录 `asr.md`。
> **范围变更（2026-11-08）**：用户确认 TTS 不需要，只做语音输入识别。本文中涉及 TTS / `SpeechSynthesis` / `SPEAKING` / barge-in 朗读的段落仅作历史调研参考；最终范围与方案以 [docs/web/语音输入设计.md](../../web/语音输入设计.md) 为准。
> 目标：在 mazi（本地优先、Vue 浏览器端 + NestJS 后端、中文为主中英混合、免费/零 API key、默认不上传音频）下，判断"默认开启实时监听"能做到什么程度，并给出可落地的交互状态机与降级策略。
> 方法：2025–2026 官方文档/浏览器发布说明/竞品帮助中心 + 实测待办；无法证实处标"未核实"。

---

## 0. 结论先行

| # | 结论 | 依据 |
|---|---|---|
| 1 | **浏览器层面不可能真正做到"打开即静默常驻"**：麦克风采集只存在于页面生命周期内；首次授权至少要用户与权限弹窗交互，恢复 AudioContext 必须有用户手势；关闭标签页、锁屏、后台挂起都会停止。 | [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)（secure context）、[Chrome Autoplay 政策](https://developer.chrome.com/blog/autoplay)（AudioContext 需手势 resume） |
| 2 | **"默认开启"可行的产品定义**：语音模式一旦开启，本次会话内默认持续监听、无需按住说话；跨会话记住偏好；冷启动能自动开麦时自动开麦，不能时降级为"一次点击开始"，并在 UI 里说明原因。 | ChatGPT/Claude 均为"进入语音模式后连续监听"，见 §4 |
| 3 | **默认不上传音频 ⇒ 不能用浏览器 Web Speech 作默认**：Chrome 的 SpeechRecognition 默认是服务端识别，音频会发给 Google；Safari 用 Siri 引擎并依赖系统听写服务。 | [MDN SpeechRecognition 注](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)、[WebKit Safari 14.1](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/) |
| 4 | **首选方案 B：浏览器 AudioWorklet 采集 → 本地 runtime 流式 ASR**（WebSocket/SSE 出 partial）。同时解决 Firefox 无 SpeechRecognition、隐私不上传、中文可换大模型三个问题；代价是模型分发与 CPU/内存成本。 | §9；引擎细节见 `asr.md` |
| 5 | **自动发送默认开、但不能语音审批**：说完自动发送符合"低延迟"预期；但工具审批、权限提升必须保持鼠标点击确认（OpenAI 语音模式同样只支持屏幕审批、不支持口头审批）。 | [ChatGPT Voice 帮助](https://help.openai.com/en/articles/20001274-chatgpt-voice) |
| 6 | **最大风险**：Chrome on-device 识别中文语言包是否可用、Safari 连续识别稳定性、以及"默认开麦"引发的信任问题（浏览器/系统常驻麦克风指示、误触发、他人声音）。 | §8、§10 |

**一句话推荐**：默认走"本地流式 ASR + 浏览器 VAD 门控"的语音模式（首选 B），把浏览器 Web Speech 仅作为显式同意的降级/试用路径（降级 A），纯浏览器 WASM ASR 作备选（C）；交互上采用"进入语音模式 = 默认持续监听 + 常驻指示条 + 一键暂停 + 说完自动发送 + 点击审批"。

---

## 1. mazi 现状与硬约束

| 约束 | 事实（代码/文档） | 对语音输入的影响 |
|---|---|---|
| 前端 | Vue 3.5 + Vite，单页；输入区为 `apps/webui/src/components/Composer.vue`；已有 SSE 流式渲染与权限档位（read-only 等） | 语音入口应嵌在 Composer；partial 文本只能走"临时草稿"通道，不能混进 SSE 会话流 |
| 后端 | NestJS + Fastify，默认 6294；UI 开发/预览 6295，`/api` 代理 | 本地 ASR 可作为 runtime 内模块或 sidecar，经 WS/SSE 与 UI 通信 |
| 访问方式 | 开发 `vite.config.ts` 中 `host: 0.0.0.0`；生产 `serve.mjs` 的 `listen(PORT)` 未指定 host（实际绑定所有网卡，日志只打印 127.0.0.1） | **localhost 属安全上下文可用麦克风；用局域网 IP（http://192.168.x.x:6295）打开则不是安全上下文，麦克风直接被禁** → 手机/局域网调试必须 HTTPS 或经本机 localhost 访问 |
| 平台 | macOS 为主，兼顾 Windows/Linux | 需处理 macOS TCC 权限、Windows 隐私设置、Linux 无麦克风/无 AEC 设备 |
| 语言 | 中文为主、中英混合 | 引擎需 zh-CN 为主、支持中英混说；浏览器 on-device 中文支持未核实 |
| 成本 | 免费/零 API key | 排除任何云 ASR 默认路径；TTS 本期不做 |
| 隐私 | 用户明确要求"默认不上传音频" | Web Speech 默认云端识别的路线不能作默认；音频不落盘要写进默认值 |
| 已有交互 | 审批弹窗（`ApprovalPrompt.vue`）、权限档位、停止/继续 | 语音只负责"产生用户消息"，不绕过既有权限与审批 |

---

## 2. 浏览器硬约束（能力矩阵）

### 2.1 支持矩阵（2026-11 现状）

| 能力 | Chrome | Safari | Firefox | Edge | 备注 |
|---|---|---|---|---|---|
| getUserMedia（麦克风） | ✅ | ✅（iOS 仅 WebKit） | ✅ | ✅ | 需 secure context；见 2.2 |
| AudioWorklet（低延迟 PCM） | ✅ | ✅ 14.1+ | ✅ | ✅ | [WebKit 14.1](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/)；采集用 Worklet 免主线程卡顿 |
| SpeechRecognition | ✅（webkit 前缀 33+，无前缀 139+） | ✅ 14.1+（webkit 前缀） | ❌ 默认不可用（about:config flag；BCD 与 caniuse 记录不一致） | ⚠️ caniuse 标"事件不触发" | [caniuse 数据](https://caniuse.com/speech-recognition)、[MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json) |
| 连续识别 `continuous` | ✅ | ⚠️ 17+ 才有 `continuous` | — | — | Safari 14.1 只支持非连续；需 onend 重启 |
| on-device 识别（processLocally/available/install） | ✅ 139+ | ❌ | ❌ | 未核实 | [Chrome 139 发布说明](https://developer.chrome.com/blog/new-in-chrome-139)；语言包按语言下载、装后离线可用 |
| 默认识别是否上传音频 | **是（服务端识别，音频送 Google）** | ⚠️ 走 Siri 引擎/系统听写，是否上传 Apple 未核实 | — | 未核实 | [MDN 明确说明](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)、[WebKit 14.1](https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/) |
| SpeechSynthesis（TTS，**本期不做**） | ✅ | ✅ | ✅ | ✅ | 仅保留为历史参考；Chrome 需用户手势且存在长文本截断（见 caniuse） |
| 后台常驻监听 | ❌ | ❌ | ❌ | ❌ | 页面关闭/锁屏即停；移动端后台挂起（具体行为未核实，设计上不可假设） |

> 结论：**Firefox 是明确的降级对象**（无可用 SpeechRecognition，Web Speech 也非标准）；Edge 虽同源 Chromium，但 caniuse 标注识别事件不触发，**不可依赖**。若采用本地 ASR（方案 B），Firefox 只受"能否采集/播放"影响，反而可用。

### 2.2 安全上下文与权限

- `getUserMedia` 只在 **secure context**（HTTPS 或 localhost/127.0.0.1）可用；否则 `navigator.mediaDevices` 为 undefined 或直接拒绝。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- **授权不是永久承诺**：
  - Chrome 116+ 麦克风授权新增 **"Allow this time / Allow on every visit / Don't allow"**；"仅这次"只在当前交互内有效。[Chrome one-time permissions](https://developer.chrome.com/blog/one-time-permissions)
  - Firefox 115+ 摄像头/麦克风默认就是一次性授权（可勾选持久）。[同上]
  - Safari 的麦克风授权是否按站点持久、是否每次会话重弹：**未核实**（公开文档不清），设计上按"可能每次都要重新授权"处理。
- 权限可被随时撤销且没有可靠"已被撤销"的实时事件；应在每次进入语音模式时用 Permissions API 查询 + 实际 `getUserMedia` 探测，失败即降级（[Permissions API](https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API)）。
- macOS 还有系统级 TCC 授权（浏览器自身要获得麦克风权限）；系统会显示麦克风使用指示（[Apple 支持](https://support.apple.com/guide/mac-help/control-access-to-your-microphone-on-mac-mchla1b1e1fe/mac)）。即使用户在网页里允许，系统层仍可能拒绝——必须处理 `NotAllowedError`/`NotReadableError`。

### 2.3 用户手势 / 自动播放

| 行为 | 约束 | 来源 |
|---|---|---|
| `AudioContext` 启动/恢复 | Chrome 71 起受自动播放政策约束；页面加载前创建的 AudioContext 是 suspended，必须用户手势后 `resume()` | [Chrome Autoplay](https://developer.chrome.com/blog/autoplay) |
| `speechSynthesis.speak()` | Chrome 71 起**无用户激活会抛错**（曾被滥用做广告）；TTS 首次播放必须放在手势/语音模式启动之后 | [Chrome 71 弃用说明](https://developer.chrome.com/blog/chrome-71-deps-rems) |
| `SpeechRecognition.start()` | 浏览器实现差异大；Safari 通常要求在用户手势内调用；Chrome 一般可无手势调用（**实现差异未核实，按需手势设计**） | MDN / WebKit |
| 权限弹窗 | 无手势可弹，但弹窗可能被忽略（Promise 既不 resolve 也不 reject），必须有超时兜底 | [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) |

### 2.4 音频处理与 VAD

- 采集链路：`getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1}})` → AudioWorklet 取 16kHz PCM → 本地 VAD → ASR。AEC 是 barge-in 的前提（AEC 是标准约束，见 [MDN MediaTrackConstraints](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints)）。
- VAD 可选：Silero VAD（MIT，10k+ star，持续维护，[GitHub](https://github.com/snakers4/silero-vad)）或能量/过零率简易 VAD；浏览器封装 `@ricky0123/vad` 仓库 license 字段为 NOASSERTION，**许可证需人工确认**（[repo](https://github.com/ricky0123/vad)）。
- 建议 VAD 在浏览器侧门控：静音不发包，只有语音段才送本地 ASR —— 降低 CPU/带宽，也让"常驻监听"在静音时几乎无成本。
- 已知坑：Chrome 的 `SpeechRecognition` 连续会话会因网络/静音断开，社区通行做法是 `onend` 里自动重启（[SO 讨论](https://stackoverflow.com/questions/63644932/web-speech-recognition-automatically-disconnects)）；本地 ASR 也应假定"连接会断"，用重连 + 状态机兜底。

---

## 3. 默认开启连续监听：冲突清单

| # | 冲突 | 具体表现 | 设计结论 |
|---|---|---|---|
| C1 | 默认开启 vs 首次手势 | 冷启动自动 `getUserMedia` 可能弹权限框、AudioContext 被挂起、Safari 可能要求手势 | 冷启动"尝试自动开麦"；失败则一次点击开始，并说明"浏览器要求一次点击"，不反复弹窗 |
| C2 | 默认开启 vs 一次性授权 | 用户可能选"仅这次"；刷新/新会话权限消失 | 检测 permission 状态；不能自动恢复时提示"选择『每次访问都允许』可默认监听"；绝不循环请求权限 |
| C3 | 常驻监听 vs 页面生命周期 | 标签页关闭/切后台/锁屏即停；移动端切后台会被挂起 | 明确"仅本页面前台监听"；切后台自动暂停并在返回时提示恢复；不做"后台偷偷听"的承诺 |
| C4 | 常驻监听 vs 系统/浏览器指示 | 浏览器 tab 麦克风图标、macOS 橙点常亮；用户会紧张 | 应用内必须有同步的常驻状态条（麦克风 + 波形 + "正在听/已暂停"），并解释"系统图标 = 正在监听，点暂停即消失" |
| C5 | 默认开启 vs 隐私敏感场景 | 会议、他人在场、共享屏幕、录屏 | 提供一键暂停（快捷键 + 顶部按钮）；共享屏幕/录屏检测可做提示（能力未核实）；提供"共享电脑默认关闭监听"设置 |
| C6 | 自动发送 vs 误触发 | 电视/他人说话/环境噪声被识别成指令，直接触发 agent | VAD 门控 + 最小语音时长 + endpointing；自动发送只发生在"语音模式且 run 空闲"；危险操作仍走审批；保留"撤销/停止" |
| C7 | 语音 vs 审批安全 | 语音可被录音回放/他人模仿 | **不允许语音确认审批**；审批必须点击；语音模式不得自动提升权限档位 |

---

## 4. 竞品模式（可借鉴 / 不可照搬）

| 产品 | 默认监听 | 授权/启动 | 常驻指示 | 自动发送 | 打断（barge-in） | 暂停/关闭 | 隐私默认 |
|---|---|---|---|---|---|---|---|
| **ChatGPT Voice** | 进入语音模式后连续对话；"Live" 可边听边说 | 点语音入口 → 系统麦克风授权 | 语音模式界面常驻 | 连续对话，无"发送"按钮语义（未核实是否可编辑） | ✅ Live 边听边说，turn-taking/打断更自然 | 退出语音模式 | Live/Advanced 音频片段保留 30 天（随聊天记录）；Standard 转写后即删音频；审批只支持屏幕点击 |
| **Claude Voice** | ✅ **hands-free 默认持续听**，按自然停顿响应 | 点声波图标进入；首次授权 | 语音模式界面 + Stop 按钮 | 说完自动进入回复 | ✅ 说话即打断，Claude 停止并听 | 右下角 Stop 退出；可切 push-to-talk | 移动端/桌面/Web beta；未公开音频保留细节（未核实） |
| **Siri** | 唤醒词"Hey Siri"常驻（系统级） | 系统设置开启 | 屏幕/状态指示 | 指令即执行 | 可说"停" | 系统级关闭 | 尽量设备端；默认不保留音频（除非用户选择加入改进）——[Apple 声明](https://www.apple.com/newsroom/2025/01/our-longstanding-privacy-commitment-with-siri/) |
| **Windows Voice Access** | 三态：Sleep（仅唤醒词）/ Listening / Mic off | 系统设置 + 麦克风按钮 | 顶部常驻条 + 麦克风状态 | 命令直接执行 | 唤醒词/按钮切换 | 麦克风按钮、快捷键、语音命令 | 官方称可离线使用；具体识别是否上云未核实 |
| **Superwhisper** | ❌ 默认按住/切换录音（⌥Space） | 快捷键触发 | 录音小窗 | 转写后插入文本 | 不适用（单次听写） | 取消录音快捷键；可设录音保留期自动删除 | 本地模型可选；录音保留可配置 |
| **Wispr Flow** | 默认听写式；另有官方 hands-free 模式 | 快捷键触发 | 录音状态 | 转写后输入 | 不适用 | 快捷键/设置 | 免费额度 + 云端为主（未核实细节） |

**可借鉴的三条**（其余条目细节以官方文档为准，未核实处已标注）：
1. **"模式化"而非"开关化"**：Claude/ChatGPT 都是"进入语音模式"后默认连续监听、离开即停，既满足"默认开启"体验，又天然有暂停入口。
2. **多态麦克风**：Windows Voice Access 的 Sleep/Listening/Off 三态比"开/关"两态更贴合常驻监听（Sleep 只等唤醒词，适合长时间挂着）。
3. **审批不上语音**：ChatGPT 明确语音模式下的敏感操作仍需屏幕点击。mazi 有审批/权限体系，直接沿用这条红线。

**不可照搬**：
- Siri/Voice Access 是系统级应用，可常驻系统麦克风；浏览器页面做不到。
- ChatGPT/Claude 默认上传音频到云端；mazi 要求默认不上传，必须换本地链路，代价是模型分发与 CPU。

---

## 5. 推荐交互状态机

### 5.1 状态定义

| 状态 | 含义 | UI | 麦克风 |
|---|---|---|---|
| `OFF` | 语音未启用（默认冷启动状态） | Composer 麦克风按钮（灰） | 关闭 |
| `REQUESTING` | 正在请求权限/恢复 AudioContext | 按钮 loading + "正在准备麦克风…" | 尝试打开 |
| `ARMED` | 已监听、静音等待说话 | 常驻条："正在听…"（呼吸波形） | 开（VAD 门控） |
| `CAPTURING` | VAD 检测到语音，正在采集 | 波形活跃 + "正在识别…" | 开 |
| `PARTIAL` | 有 interim 文本 | Composer 显示斜体临时文本 | 开 |
| `THINKING` | 已自动发送，等待/生成回复 | 常驻条："思考中"（可继续听，允许打断） | 开（全双工）或暂停（半双工） |
| `SPEAKING` | TTS 播放中 | 常驻条："正在朗读 · 可说话打断" | 开（AEC 下保持识别） |
| `INTERRUPTED` | 用户打断 TTS/生成 | 闪烁提示"已打断" | 开 |
| `PAUSED` | 用户手动暂停 | 常驻条："已暂停 · 点麦克风恢复" | 关闭（指示灯灭） |
| `ERROR` | 权限/设备/网络/ASR 失败 | 错误条 + 文字输入兜底 | 关闭 |

### 5.2 关键迁移

| 事件 | 从 | 到 | 副作用 |
|---|---|---|---|
| 用户点麦克风/快捷键 | OFF/PAUSED | REQUESTING | 手势内 `getUserMedia` + `audioContext.resume()` |
| 授权成功且偏好=默认监听 | REQUESTING | ARMED | 显示常驻条；记住"本次会话已启用" |
| 授权被拒/设备缺失 | REQUESTING | ERROR | 降级文字；给出地址栏授权指引；**不重复弹窗** |
| VAD 检测到语音（>200ms） | ARMED | CAPTURING | 采集 PCM；开始 partial |
| 收到 interim | CAPTURING | PARTIAL | 仅更新草稿层，不入会话 |
| 静音超过 endpointing（建议 600–800ms） | CAPTURING/PARTIAL | THINKING | 提交 final 文本 → 自动发送（可配置为待确认） |
| 生成开始 | THINKING | （保持 THINKING） | 流式渲染；允许继续听 |
| TTS 开始 | THINKING | SPEAKING | 全双工：VAD 阈值提高；半双工：暂停 ASR |
| SPEAKING 中 VAD 命中（>300ms 且非 TTS 回声） | SPEAKING | INTERRUPTED | 立即停 TTS + 中断生成（或标记）；把新语音作为下一轮输入 |
| TTS 结束 | SPEAKING | ARMED | 恢复默认 VAD 阈值 |
| 用户点暂停/快捷键 | 任意 | PAUSED | 停采集、停 TTS、常驻条变灰 |
| 用户点关闭语音模式 | 任意 | OFF | 释放 MediaStream（浏览器指示器消失） |
| 页面隐藏/锁屏 | 任意 | PAUSED | 释放采集；返回时提示恢复 |
| 空闲 N 分钟（建议 10） | ARMED | PAUSED | 省电；点击/快捷键恢复 |

### 5.3 barge-in 策略（分级）

| 级别 | 条件 | 行为 | 风险 |
|---|---|---|---|
| 全双工（默认目标） | AEC 生效、实测无自激 | TTS 播放中保持 ASR，VAD 阈值 +3–6dB、最短 300ms；命中即停 TTS/生成 | 回声被当输入（需实测 Chrome/Safari） |
| 半双工（保守默认，若实测不稳） | 无 AEC / 回声大 / 移动端 / 蓝牙设备 | TTS 时暂停 ASR，仅接受显式打断（空格键/点按钮/PTT） | 打断不够自然 |
| 无打断（降级） | 环境嘈杂或 ASR 不稳 | TTS 时完全停听，播完再听 | 长回复体验差 |

> 结论：先实现半双工（稳），把全双工作为开关/灰度；**barge-in 只在语音对话里生效，审批弹窗与权限变更不允许语音打断/确认**。

### 5.4 自动发送 vs 确认

| 策略 | 建议 | 理由 |
|---|---|---|
| 默认 | 语音模式内**说完自动发送**（endpointing 后） | 对齐 Claude hands-free / ChatGPT Live 的"自然对话"预期；否则每句都要点击，体验断裂 |
| 可配置 | "说完先显示，Enter/确认后发送" | 嘈杂环境/内容敏感时使用 |
| 安全闸门 | 语音发送不提升权限；工具调用仍走审批；提供"停止"按钮 | mazi 已有权限档位与审批，语音不应绕过 |
| 纠错 | final 前允许点"重说"；发送后 2s 内可"停止"当前 run | 降低误触发成本 |

### 5.5 文案要点（中文为主，中英混排保留）

| 场景 | 文案 |
|---|---|
| 首次授权 | "mazi 想使用麦克风。识别在本机完成，音频不会上传。允许后本次会话默认持续监听。" |
| 一次性授权 | "你选择了『仅这次允许』。刷新页面后需要再次授权；选择『每次访问都允许』可默认开启监听。" |
| 监听中 | "正在听… 说完停顿一下即自动发送" |
| 识别中 | "识别中…（可继续说完）" |
| 暂停 | "语音输入已暂停 · 点击麦克风或按 ⌘⇧M 恢复" |
| 权限被拒 | "麦克风被拒绝。点地址栏的麦克风图标重新允许，或继续用文字输入。" |
| 不支持（Firefox） | "当前浏览器不支持浏览器内语音识别；已切换到本机识别/文字输入。" |
| 朗读中 | "正在朗读 · 直接说话可以打断" |
| 审批 | "语音模式下，涉及工具执行的操作仍需你点击确认。" |

---

## 6. 隐私默认值与红线

| 项 | 默认值 | 说明 / 依据 |
|---|---|---|
| 音频上传 | ❌ 不上传 | 默认本地 ASR；Web Speech 兜底默认关闭，若开启必须显式告知"音频将发送到浏览器厂商服务"（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)） |
| 音频落盘 | ❌ 不落盘 | 仅内存环形缓冲（建议 ≤30s）；不写 localStorage/IndexedDB/日志/SSE 事件；崩溃转储也不含 PCM |
| 转写文本 | 仅作为用户消息进会话 | 与打字输入同权：用户可见、可删；不进 audit/telemetry；日志脱敏 |
| 自动发送 | 语音模式内开 | 见 §5.4；误触发可停 |
| 常驻监听范围 | 仅当前标签页前台 | 页面隐藏/锁屏即暂停；不承诺后台 |
| 暂停入口 | 常驻条按钮 + 快捷键（建议 ⌘/Ctrl+Shift+M）+ 语音命令"暂停"（可选） | 一键让系统麦克风指示消失 |
| 状态指示 | 应用内常驻条 + 依赖系统指示（浏览器 tab 图标、macOS 橙点） | 用户必须能随时知道"是否在听" |
| 第三方上传开关 | 默认关；单独设置项，开启时二次确认 | 企业/离线部署应可策略强制关闭 |
| 数据保留 | 语音会话不新增保留；与聊天记录一致 | 依据 PIPL 最短必要（第 6/19 条） |

**合规要点（非法律意见）**：
- 音频属于个人信息；默认本地处理 = 数据最小化（PIPL 第 6 条；GDPR Art.5 [链接](https://gdpr-info.eu/art-5-gdpr/)）。
- 若提供"上传/云识别"选项，需按 PIPL 第 17 条告知处理目的/方式/种类/期限，第 14 条取得同意（敏感场景需单独同意），第 15 条提供便捷撤回（[PIPL 全文](http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html)）。
- 若未来做声纹/说话人识别，会落入敏感个人信息（PIPL 第二章第二节），**当前设计明确不做声纹**。
- 企业/离线：本地 ASR 可完全断网运行，是 mazi 相对云产品的差异点；界面应能显示"本机识别/离线"标识。

---

## 7. 降级矩阵（必须逐条实现）

| 场景 | 检测 | 行为 | 文案 |
|---|---|---|---|
| 非安全上下文（LAN http） | `!window.isSecureContext` 或 `!navigator.mediaDevices` | 隐藏麦克风，只留文字；提示用 localhost/HTTPS | "当前地址不是安全上下文，浏览器禁止麦克风。请用 http://localhost:6295 或 HTTPS 访问。" |
| Firefox | 无 `SpeechRecognition`（但本地 ASR 可用） | 走本地 ASR（方案 B），否则文字 | "本浏览器不支持内置语音识别，已使用本机识别。" |
| Edge | caniuse 标识别事件不触发 | 同 Firefox：本地 ASR 优先；浏览器识别不启用 | 同上 |
| Safari | 有 webkitSpeechRecognition 但依赖 Siri/听写；continuous 17+ | 优先本地 ASR；浏览器识别仅作可选；不做"必须 Siri"的默认路径 | "Safari 的语音识别依赖系统听写，已使用本机识别。" |
| 权限被拒 | `NotAllowedError` | ERROR，降级文字；指引地址栏；不重复弹窗 | §5.5 |
| 无麦克风/被占用 | `NotFoundError`/`NotReadableError` | ERROR，降级文字 | "没有检测到麦克风，或麦克风被其他应用占用。" |
| ASR 连不上/超时 | 连接失败/无 partial 3s | 自动重连 1 次；仍失败则降级文字并保留已识别文本 | "本机识别暂不可用，已切回文字输入。" |
| 页面隐藏/锁屏 | `visibilitychange` | PAUSED，释放采集；返回时询问是否恢复 | "语音输入已暂停（页面切到后台）。" |
| on-device 语言包缺失（Chrome） | `available()` 返回 downloadable | 提示下载语言包或改用本地 ASR；**中文包是否可用未核实** | "需要先下载中文语音包（体积未核实）。" |

---

## 8. 未核实 / 风险清单

| # | 项 | 状态 | 影响 | 建议 |
|---|---|---|---|---|
| R1 | Chrome 139 on-device 识别中文语言包是否可用、体积、是否需 flag | **未核实**（ChromeStatus 标 v139 developer trial/flag；Kinlan [showcase](https://chrome-platform-showcase.paulkinlan-ea.deno.net/v139/on-device-web-speech-api/availability-and-language-matrix/) 列出 zh-CN 探测项但非承诺） | 若中文不可用，浏览器 on-device 路线对 mazi 无意义 | 开发期实测 `available({langs:['zh-CN'],processLocally:true})`；不作为默认依赖 |
| R2 | Chrome on-device 稳定性 | 已知 issue：Windows Chrome 155 "检测到语音但 result 不触发"（[issues.chromium.org/579050368](https://issues.chromium.org/issues/579050368)） | 不能把 on-device 当唯一路径 | 兜底本地 ASR |
| R3 | Safari 连续识别稳定性、音频是否上传 Apple、是否每次弹权限 | **未核实** | 影响 Safari 默认监听体验 | 实测；Safari 走本地 ASR |
| R4 | Chrome SpeechRecognition + speechSynthesis 同时开时 AEC 是否足够 | **未核实**（需浏览器实测回声） | 全双工 barge-in 可能自激 | 先半双工，灰度高阈值全双工 |
| R5 | ~~Chrome SpeechSynthesis 长文本约 15s 截断~~ | 已随 TTS 取消移出范围 | — | 不适用 |
| R6 | macOS/Windows 系统级权限与浏览器权限叠加 | 已知存在，具体失败码需实测 | 首启失败率高 | 统一错误映射与指引 |
| R7 | 长时间常驻监听的 CPU/电量 | 未量化 | 笔记本掉电、风扇 | VAD 浏览器侧门控 + 空闲暂停 + 默认 10 分钟休眠 |
| R8 | 误触发造成 agent 执行 | 设计可缓解但无法消除 | 安全/信任 | 审批不可语音确认；语音不自动提权；停止按钮 |

---

## 9. Top-3 方案短名单与推荐

> 三条路线都是"输入侧链路"，与具体 ASR 引擎解耦；引擎选型见 `asr.md`。TTS 已取消。

| 方案 | 链路 | 隐私 | 延迟/partial | 浏览器覆盖 | 成本/复杂度 | 结论 |
|---|---|---|---|---|---|---|
| **B（首选）浏览器采集 + 本地 runtime 流式 ASR** | AudioWorklet PCM → 本地 VAD → WebSocket/SSE → runtime 内 ASR（sherpa-onnx/whisper.cpp/FunASR 等）→ partial 回 UI | ✅ 音频不出设备 | 可控（流式 partial，目标 <300ms 首字） | ✅ Chrome/Safari/Firefox/Edge（只要能采集） | 需模型分发、CPU/内存、WS 协议 | **推荐首选**：唯一同时满足"默认不上传 + Firefox 可用 + 中文可换模型"的路线 |
| **C（备选）纯浏览器 WASM/WebGPU ASR** | 页面内 transformers.js / sherpa-onnx wasm / whisper.cpp wasm 直接识别 | ✅ 最强（无后端） | partial 可能较慢（CPU 推理） | ✅ 需 WASM SIMD/WebGPU；iOS 内存受限 | 首次模型下载大（数十–数百 MB）、移动端慢 | 备选：零安装/离线演示；不作为桌面默认 |
| **A（降级）浏览器 Web Speech API** | Chrome 云端识别或 139+ on-device；Safari Siri 引擎 | ❌ 默认云端上传（Chrome 送 Google）；on-device 中文未核实 | ✅ 低延迟、免模型 | Chrome/Safari；Firefox 无；Edge 不可靠 | 零成本、零安装 | 仅作"显式同意的试用/降级"，不能作默认 |

**推荐组合**：
1. **默认：B**（本地流式 ASR + 浏览器 VAD 门控 + 状态机 §5）；TTS 已取消，不实现语音播报。
2. **备选：C**（纯前端 WASM），用于"不想装任何东西"的场景或离线演示。
3. **降级：A**（Web Speech），仅在用户明确同意上传音频、且 B/C 不可用时启用；Firefox/Edge 不展示该入口。
4. **不推荐**：把 A 当默认 —— 与"默认不上传音频"直接冲突，且 Firefox（mazi 明确要支持）不可用。

**落地落点（设计级，不含实现）**：
- UI：`Composer.vue` 增加语音入口 + partial 草稿层；新增常驻语音状态条；设置页新增"语音输入"分区（默认监听、自动发送、暂停快捷键、隐私开关）。
- 状态：新增独立 voice store（OFF/ARMED/CAPTURING/…/PAUSED，见 §5.1），与 run 状态（busy/空闲）解耦。
- 通信：新增 `/api/voice/stream`（WS 或 SSE）承载 PCM/partial；不写入现有会话 SSE 事件流。
- 安全：语音发送沿用现有权限档位与 `ApprovalPrompt.vue`；语音不可确认审批、不可提权。
- 可观测：只记录"是否启用/耗时/错误码"，不记录音频与转录全文到日志。

---

## 10. 参考来源

**浏览器/平台**
- MDN getUserMedia（secure context / 权限错误）：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN SpeechRecognition（服务端识别、音频上传、on-device 属性）：https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- MDN Using the Web Speech API（on-device 语言包/available/install/Permissions-Policy）：https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API
- MDN BCD SpeechRecognition（版本支持）：https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json · caniuse Speech Recognition（Firefox/Edge 限制、Safari 注记）：https://caniuse.com/speech-recognition
- caniuse Speech Synthesis（Chrome 15s 截断注记）：https://caniuse.com/speech-synthesis
- Chrome 139 发布说明（on-device Web Speech API）：https://developer.chrome.com/blog/new-in-chrome-139
- Chrome one-time permissions（Chrome 116 / Firefox 115 一次性授权）：https://developer.chrome.com/blog/one-time-permissions
- Chrome 71 弃用（speechSynthesis 需用户激活）：https://developer.chrome.com/blog/chrome-71-deps-rems
- Chrome Autoplay 政策（AudioContext 需手势）：https://developer.chrome.com/blog/autoplay
- WebKit Safari 14.1（SpeechRecognition 用 Siri 引擎、需启用 Siri、AudioWorklet）：https://webkit.org/blog/11648/new-webkit-features-in-safari-14-1/
- on-device 语言/质量探测 demo（ChromeStatus developer trial 注记）：https://chrome-platform-showcase.paulkinlan-ea.deno.net/v139/on-device-web-speech-api/
- Chromium issue（on-device 识别不触发 result）：https://issues.chromium.org/issues/579050368
- Web Speech 连续识别断开（社区实践）：https://stackoverflow.com/questions/63644932/web-speech-recognition-automatically-disconnects

**竞品**
- ChatGPT Voice 帮助（Live/Standard、审批仅屏幕、音频保留 30 天）：https://help.openai.com/en/articles/20001274-chatgpt-voice
- Claude Voice 帮助（hands-free 默认、PTT、Stop、打断）：https://support.claude.com/en/articles/11101966-use-voice-mode
- Windows Voice Access（三态麦克风、离线）：https://support.microsoft.com/en-us/accessibility/windows/voice-access/get-started-with-voice-access
- Superwhisper 设置文档（切换/按住说话、取消、录音保留）：https://superwhisper.com/docs/get-started/essential-settings
- Wispr Flow hands-free 帮助：https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free
- Apple Siri 隐私（默认不保留音频、尽量设备端）：https://www.apple.com/newsroom/2025/01/our-longstanding-privacy-commitment-with-siri/ · Siri/听写隐私说明：https://www.apple.com/legal/privacy/data/en/ask-siri-dictation/
- macOS 麦克风权限控制：https://support.apple.com/guide/mac-help/control-access-to-your-microphone-on-mac-mchla1b1e1fe/mac

**隐私/合规**
- 《个人信息保护法》全文（第 6/14/15/17/19 条等）：http://www.npc.gov.cn/npc/c2/c30834/202108/t20210820_313088.html
- GDPR Art.5（数据最小化）：https://gdpr-info.eu/art-5-gdpr/

**VAD**
- Silero VAD（MIT）：https://github.com/snakers4/silero-vad · @ricky0123/vad（浏览器封装，license 字段 NOASSERTION 需确认）：https://github.com/ricky0123/vad
