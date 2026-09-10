import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Render model Markdown to sanitized HTML (GFM + DOMPurify). */
export function renderMarkdown(text: string): string {
    if (!text) return '';
    // breaks: render single newlines as <br> instead of relying on a container
    // white-space:pre-wrap, which turned HTML-source newlines into extra blank lines.
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    const clean = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
    });
    // Force safe external-link attributes on every anchor.
    const tmp = document.createElement('div');
    tmp.innerHTML = clean;
    tmp.querySelectorAll('a').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
    });
    return tmp.innerHTML;
}
