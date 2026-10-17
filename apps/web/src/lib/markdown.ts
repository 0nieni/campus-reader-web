import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { safeOriginal } from "./presentation";
const parser = new MarkdownIt({ html: false, linkify: false, breaks: true }).disable("image");
export function renderMarkdown(text: string): string {
  const clean = DOMPurify.sanitize(parser.render(text), { ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "blockquote", "pre", "code", "a", "br", "hr", "table", "thead", "tbody", "tr", "th", "td"], ALLOWED_ATTR: ["href", "title"] });
  const node = document.createElement("div"); node.innerHTML = clean;
  for (const link of node.querySelectorAll("a")) {
    const url = safeOriginal(link.getAttribute("href"));
    if (!url) link.removeAttribute("href");
    else { link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
  }
  return node.innerHTML;
}
export function downloadFile(name: string, text: string, mime = "text/markdown;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
