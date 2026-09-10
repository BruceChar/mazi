import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** 将模型输出的 Markdown 文本渲染为安全的 HTML（GFM + DOMPurify 消毒） */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    // breaks: 保留模型输出中的单换行（渲染为 <br>），避免依赖容器 white-space:pre-wrap
    // 造成块级元素之间的 HTML 源换行被当成空行（表现为每行都有额外行距）。
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    const clean = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
    });
    // 给链接统一加安全的外链属性
    const tmp = document.createElement('div');
    tmp.innerHTML = clean;
    tmp.querySelectorAll('a').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
    });
    return tmp.innerHTML;
}
