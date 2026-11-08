<script setup>
/**
 * 录音波形：80 根短线，静音时是点状基线，随麦克风电平/时间滚动。
 * 参照 DSH VoiceInput 的 Waveform：直接改 SVG 几何，不走 Vue 响应式高频渲染。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
    /** 当前麦克风电平 0..1。 */
    level: { type: Number, default: 0 },
    /** false 时波形停在当前状态（例如正在转写）。 */
    active: { type: Boolean, default: true },
});

const svg = ref(null);
const BARS = 80;
const levels = new Array(BARS).fill(0);
let raf = 0;
let frame = 0;

function draw() {
    if (!props.active) {
        raf = 0;
        return;
    }
    // 每两帧推进一格，约保留最近 2.6 秒的电平历史。
    frame += 1;
    if (frame % 2 === 0) {
        levels.shift();
        levels.push(Math.min(1, Math.max(0, Number(props.level) || 0) * 5.5));
    }
    const lines = svg.value?.querySelectorAll('line');
    if (lines) {
        for (let index = 0; index < lines.length; index += 1) {
            const value = levels[index] ?? 0;
            const height = Math.max(2, Math.min(34, value * 34));
            const line = lines[index];
            line.setAttribute('y1', String(20 - height / 2));
            line.setAttribute('y2', String(20 + height / 2));
            line.setAttribute('opacity', String(0.3 + index / 160));
        }
    }
    raf = requestAnimationFrame(draw);
}

onMounted(() => {
    raf = requestAnimationFrame(draw);
});

// requesting → armed 时组件已挂载但 active 从 false 变 true，需要重新启动动画。
watch(
    () => props.active,
    (active) => {
        if (active && !raf) raf = requestAnimationFrame(draw);
    },
);

onBeforeUnmount(() => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
});
</script>

<template>
    <svg
        ref="svg"
        class="voice-waveform"
        viewBox="0 0 640 40"
        preserveAspectRatio="none"
        role="img"
        aria-label="录音波形"
    >
        <line
            v-for="index in 80"
            :key="index"
            :x1="(index - 1) * 8 + 4"
            :x2="(index - 1) * 8 + 4"
            y1="19"
            y2="21"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            :opacity="0.25 + (index - 1) / 120"
        />
    </svg>
</template>

<style scoped>
.voice-waveform {
    width: 100%;
    min-width: 40px;
    height: 30px;
    color: var(--accent);
    display: block;
}
</style>
