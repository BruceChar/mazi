import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** 将模型输出的 Markdown 文本渲染为安全的 HTML（GFM + DOMPurify 消毒） */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    const raw = marked.parse(text, { async: false, gfm: true }) as string;
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
