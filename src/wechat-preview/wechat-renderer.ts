import juice from "juice/client";
import type { WechatExportTheme } from "./themes";
import { getCombinedDefaultCss, getCombinedWechatRenderers } from "@akairos/milkdown-article-plugins";

export type WechatElementKind =
  | "image"
  | "code-block"
  | "inline-code"
  | "heading"
  | "paragraph"
  | "emphasis"
  | "blockquote"
  | "link"
  | "list"
  | "table"
  | "divider"
  | "hard-break"
  | "article";

export interface WechatLinkReference {
  index: number;
  text: string;
  url: string;
}

export interface WechatRenderContext {
  document: Document;
  root: HTMLElement;
  theme: WechatExportTheme;
  references: WechatLinkReference[];
  structure?: ArticleStructure;
  strictImageDecode?: boolean;
}

/** 模板仅声明有限的结构变化，不注入脚本或任意 HTML。 */
export interface ArticleStructure {
  numberedHeadings?: boolean;
  headingLabel?: string;
  quoteLabel?: string;
  headerImageUrl?: string | null;
  calloutPresets?: Record<string, { title?: string; icon?: string }>;
}

export interface WechatElementRenderer {
  kind: WechatElementKind | string;
  selector: string;
  /** Optional selector used after CSS has been inlined. Defaults to selector. */
  finalizeSelector?: string;
  prepare?: (element: HTMLElement, context: WechatRenderContext) => void | Promise<void>;
  finalize?: (element: HTMLElement, context: WechatRenderContext) => void;
}

export type WechatRendererOverrides = (Partial<Record<WechatElementKind, WechatElementRenderer>> & {
  extraRenderers?: WechatElementRenderer[];
}) | Record<string, WechatElementRenderer>;

export interface RenderWechatHtmlInput {
  structure?: ArticleStructure;
  semanticHtml: string;
  baseCss: string;
  customCss?: string;
  editorVars?: Record<string, string>;
  theme: WechatExportTheme;
  renderers?: WechatRendererOverrides;
  strictImageDecode?: boolean;
}

const ALLOWED_TAGS = new Set([
  "section",
  "p",
  "blockquote",
  "ul",
  "ol",
  "li",
  "pre",
  "code",
  "span",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
  "a",
  "img",
  "br",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

const DROP_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "button",
  "input",
  "textarea",
  "select",
  "link",
  "meta",
  "svg",
  "math",
  "canvas",
  "template",
  "noscript",
  "video",
  "audio",
  "source",
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "color",
  "text-align",
  "line-height",
  "letter-spacing",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-style",
  "text-indent",
  "background",
  "background-image",
  "background-color",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-top-color",
  "border-top-style",
  "border-top-width",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-bottom-color",
  "border-bottom-style",
  "border-bottom-width",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "border-collapse",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "width",
  "min-width",
  "max-width",
  "height",
  "max-height",
  "display",
  "vertical-align",
  "list-style",
  "list-style-type",
  "list-style-position",
  "white-space",
  "white-space-collapse",
  "text-wrap-mode",
  "text-wrap-style",
  "word-break",
  "word-wrap",
  "overflow-wrap",
  "overflow",
  "overflow-x",
  "overflow-y",
  "box-sizing",
  "table-layout",
  "text-size-adjust",
  "-webkit-text-size-adjust",
]);

const ALLOWED_DISPLAY_VALUES = new Set([
  "block",
  "inline",
  "inline-block",
  "list-item",
  "table",
  "table-row",
  "table-cell",
  "table-row-group",
  "table-header-group",
  "none",
]);

function setNodeKind(element: HTMLElement, kind: string): void {
  element.dataset.wechatNode = kind;
}

function replaceTag(element: HTMLElement, tagName: string): HTMLElement {
  const replacement = element.ownerDocument.createElement(tagName);
  for (const attribute of Array.from(element.attributes)) {
    replacement.setAttribute(attribute.name, attribute.value);
  }
  while (element.firstChild) {
    replacement.appendChild(element.firstChild);
  }
  element.replaceWith(replacement);
  return replacement;
}

function isExternalLink(href: string): boolean {
  return /^(?:https?:)?\/\//i.test(href);
}

function imageIsOnlyContent(parent: HTMLElement, image: HTMLElement): boolean {
  return Array.from(parent.childNodes).every((node) => {
    if (node === image) return true;
    return node.nodeType === 3 && !(node.nodeValue ?? "").trim();
  });
}

// 图片缩放与图注共用导出流程：Markdown 往返读两位小数 alt 与 title；
// Crepe 块级图片 DOM 读 ratio 与 caption 属性。
const imageRenderer: WechatElementRenderer = {
  kind: "image",
  selector: "img",
  finalizeSelector: "figure, figcaption",
  async prepare(element, context) {
    setNodeKind(element, "image");
    const src = element.getAttribute("src");
    if (src) element.setAttribute("data-src", src);

    const parent = element.parentElement;
    const inOwnParagraph =
      !!parent && parent.tagName.toLowerCase() === "p" && imageIsOnlyContent(parent, element);
    // Crepe 块级图片是文章根的顶层裸 <img>，同样视为独立图片。
    const topLevelBlock = parent === context.root;
    if (!parent || (!inOwnParagraph && !topLevelBlock)) {
      return;
    }

    const ratioRaw = element.getAttribute("ratio");
    const ratioFromAttr = ratioRaw ? Number(ratioRaw) : NaN;
    const alt = element.getAttribute("alt") ?? "";
    const ratio =
      Number.isFinite(ratioFromAttr) && ratioFromAttr > 0
        ? ratioFromAttr
        : /^(?:0|[1-9]\d*)\.\d{2}$/.test(alt) ? Number(alt) : 0;
    if (ratio > 0 && Number.isFinite(ratio)) {
      // DOMParser 文档不加载图片，用浏览器图片对象读取原始尺寸。
      const sourceImage = new Image();
      let imageSrc = src ?? "";
      if (
        typeof window !== "undefined" &&
        window.location &&
        window.location.origin &&
        window.location.origin.startsWith("http") &&
        imageSrc &&
        !/^(?:https?:|data:|blob:|\/\/)/i.test(imageSrc)
      ) {
        if (imageSrc.startsWith("/") && !imageSrc.startsWith("/local-file")) {
          imageSrc = `/local-file?path=${encodeURIComponent(imageSrc)}`;
        }
      }
      sourceImage.src = imageSrc;
      try {
        await sourceImage.decode();
        if (!sourceImage.naturalWidth) throw new Error("图片原始宽度为空");
        element.style.width = `${Math.min(ratio, 1) * 100}%`;
        element.style.maxWidth = `${sourceImage.naturalWidth * ratio}px`;
        element.style.height = "auto";
      } catch (error) {
        if (context.strictImageDecode ?? true) {
          throw new Error(`无法读取缩放图片的原始尺寸：${element.getAttribute("title") || "无图注"}`, { cause: error });
        }
        // 非严格模式（如 Studio 可视化编辑预览）降级处理，保证编辑器正常渲染
        element.style.width = `${Math.min(ratio, 1) * 100}%`;
        element.style.height = "auto";
      }
    }

    const figure = context.document.createElement("figure");
    setNodeKind(figure, "image-block");
    if (inOwnParagraph) {
      parent.replaceWith(figure);
    } else {
      element.replaceWith(figure);
    }
    figure.appendChild(element);

    const caption = (element.getAttribute("caption") || element.getAttribute("title") || "").trim();
    element.removeAttribute("title");
    element.removeAttribute("caption");
    if (caption) {
      const figcaption = context.document.createElement("figcaption");
      setNodeKind(figcaption, "image-caption");
      figcaption.textContent = caption;
      figure.appendChild(figcaption);
    }
  },
  finalize(element) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "figure") replaceTag(element, "section");
    if (tagName === "figcaption") replaceTag(element, "p");
  },
};

const codeBlockRenderer: WechatElementRenderer = {
  kind: "code-block",
  selector: "pre",
  prepare(element, context) {
    setNodeKind(element, "code-block-body");
    const code = element.querySelector<HTMLElement>("code");
    if (code) setNodeKind(code, "code-block-code");

    const wrapper = context.document.createElement("section");
    setNodeKind(wrapper, "code-block");
    element.replaceWith(wrapper);

    const language = element.getAttribute("data-language")?.trim();
    if (language) {
      const label = context.document.createElement("p");
      setNodeKind(label, "code-language");
      label.textContent = language;
      wrapper.appendChild(label);
    }
    wrapper.appendChild(element);
  },
};

const inlineCodeRenderer: WechatElementRenderer = {
  kind: "inline-code",
  // 只用简单选择器，代码块判断放在 JS 里；happy-dom 等 DOM 实现不支持 :not() 内的组合器。
  selector: "code",
  prepare(element) {
    if (element.closest("pre")) return;
    setNodeKind(element, "inline-code");
  },
  finalize(element) {
    if (element.closest("pre")) return;
    replaceTag(element, "span");
  },
};

const headingRenderer: WechatElementRenderer = {
  kind: "heading",
  selector: "h1, h2, h3, h4, h5, h6",
  prepare(element, context) {
    setNodeKind(element, `heading-${element.tagName.slice(1)}`);
    if (element.tagName.toLowerCase() === "h2" && context.structure) {
      const content = context.document.createElement("span");
      setNodeKind(content, "heading-text");
      while (element.firstChild) content.appendChild(element.firstChild);
      element.appendChild(content);
      if (context.structure.numberedHeadings) {
        const number = context.document.createElement("span");
        setNodeKind(number, "heading-number");
        number.textContent = String(Array.from(context.root.querySelectorAll<HTMLElement>("h2")).indexOf(element) + 1).padStart(2, "0");
        element.prepend(number);
      }
      if (context.structure.headingLabel) {
        const label = context.document.createElement("span");
        setNodeKind(label, "heading-label");
        label.textContent = context.structure.headingLabel;
        element.prepend(label);
      }
    }
  },
  finalize(element) {
    replaceTag(element, "section");
  },
};

const paragraphRenderer: WechatElementRenderer = {
  kind: "paragraph",
  selector: "p",
  prepare(element) {
    if (!element.dataset.wechatNode) setNodeKind(element, "paragraph");
  },
};

const emphasisRenderer: WechatElementRenderer = {
  kind: "emphasis",
  selector: "strong, b, em, i, s, del, u, mark",
  prepare(element) {
    setNodeKind(element, element.tagName.toLowerCase());
  },
  finalize(element) {
    if (element.tagName.toLowerCase() === "mark") replaceTag(element, "span");
  },
};

const blockquoteRenderer: WechatElementRenderer = {
  kind: "blockquote",
  selector: "blockquote",
  prepare(element, context) {
    setNodeKind(element, "blockquote");
    if (context.structure?.quoteLabel) {
      const label = context.document.createElement("p");
      setNodeKind(label, "quote-label");
      label.textContent = context.structure.quoteLabel;
      element.prepend(label);
    }
  },
  finalize(element) {
    // 微信编辑器会给原生 blockquote 强制加灰色左边框，导出时降级为 section，外观全靠内联样式。
    replaceTag(element, "section");
  },
};

/** Normalize URL for reference dedupe (same target → one footnote entry). */
export function normalizeReferenceUrl(href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.hash = "";
    // Stable host casing; keep path/query as-is except trailing slash noise.
    url.hostname = url.hostname.toLowerCase();
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }
    url.pathname = path;
    return url.toString();
  } catch {
    return trimmed.replace(/\/+$/, "") || trimmed;
  }
}

/**
 * Register or reuse a related-link reference for an external URL.
 * Same URL (even with different anchor text) maps to one index.
 */
export function resolveLinkReference(
  href: string,
  text: string,
  references: WechatLinkReference[],
): WechatLinkReference {
  const normalizedUrl = normalizeReferenceUrl(href);
  const existing = references.find(
    (item) => normalizeReferenceUrl(item.url) === normalizedUrl,
  );
  if (existing) return existing;

  const reference: WechatLinkReference = {
    index: references.length + 1,
    text: text.trim() || href,
    url: href,
  };
  references.push(reference);
  return reference;
}

const linkRenderer: WechatElementRenderer = {
  kind: "link",
  selector: "a",
  prepare(element, context) {
    const href = element.getAttribute("href")?.trim() ?? "";
    if (!isExternalLink(href)) {
      setNodeKind(element, "internal-link");
      return;
    }

    const reference = resolveLinkReference(
      href,
      element.textContent?.trim() || href,
      context.references,
    );

    setNodeKind(element, "external-link");

    const marker = context.document.createElement("span");
    setNodeKind(marker, "link-marker");
    marker.textContent = `[${reference.index}]`;
    element.after(marker);
  },
  finalize(element) {
    // 微信草稿拒绝文内锚点，保留链接文字与排版。
    if (element.dataset.wechatNode === "external-link" || element.getAttribute("href")?.startsWith("#")) replaceTag(element, "span");
  },
};

const listRenderer: WechatElementRenderer = {
  kind: "list",
  selector: "ul, ol, li",
  prepare(element, context) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "ul") setNodeKind(element, "bullet-list");
    if (tagName === "ol") setNodeKind(element, "ordered-list");
    if (tagName !== "li") return;

    const isTask = element.getAttribute("data-item-type") === "task";
    setNodeKind(element, isTask ? "task-list-item" : "list-item");
    if (!isTask) return;

    const marker = context.document.createElement("span");
    setNodeKind(marker, "task-marker");
    marker.textContent = element.getAttribute("data-checked") === "true" ? "☑" : "☐";
    const content = element.querySelector<HTMLElement>(":scope > p") ?? element;
    content.prepend(marker);
  },
};

const tableRenderer: WechatElementRenderer = {
  kind: "table",
  selector: "table, thead, tbody, tr, th, td",
  prepare(element) {
    setNodeKind(element, element.tagName.toLowerCase());
  },
};

const dividerRenderer: WechatElementRenderer = {
  kind: "divider",
  selector: "hr",
  prepare(element) {
    setNodeKind(element, "divider");
  },
  finalize(element) {
    replaceTag(element, "section");
  },
};

const hardBreakRenderer: WechatElementRenderer = {
  kind: "hard-break",
  selector: "br",
  prepare(element) {
    setNodeKind(element, "hard-break");
  },
};

const articleRenderer: WechatElementRenderer = {
  kind: "article",
  selector: ".zzhub-wechat-article",
  prepare(_element, context) {
    if (context.references.length > 0) {
      const references = context.document.createElement("section");
      setNodeKind(references, "references");

      const title = context.document.createElement("p");
      setNodeKind(title, "references-title");
      title.textContent = "相关链接";
      references.appendChild(title);

      const list = context.document.createElement("ol");
      setNodeKind(list, "references-list");
      for (const reference of context.references) {
        const item = context.document.createElement("li");
        setNodeKind(item, "reference-item");
        item.textContent = `[${reference.index}] ${reference.text}: ${reference.url}`;
        list.appendChild(item);
      }
      references.appendChild(list);
      context.root.appendChild(references);
    }

    if (context.theme.footerText) {
      const footer = context.document.createElement("section");
      setNodeKind(footer, "footer");
      const text = context.document.createElement("p");
      setNodeKind(text, "footer-text");
      text.textContent = context.theme.footerText;
      footer.appendChild(text);
      context.root.appendChild(footer);
    }
  },
};

const DEFAULT_RENDERERS: WechatElementRenderer[] = [
  imageRenderer,
  codeBlockRenderer,
  inlineCodeRenderer,
  headingRenderer,
  paragraphRenderer,
  emphasisRenderer,
  blockquoteRenderer,
  linkRenderer,
  listRenderer,
  tableRenderer,
  dividerRenderer,
  hardBreakRenderer,
  articleRenderer,
];

export function createWechatRendererRegistry(
  overrides: WechatRendererOverrides = {},
): WechatElementRenderer[] {
  const base = DEFAULT_RENDERERS.map(
    (renderer) => (overrides as Record<string, WechatElementRenderer | undefined>)[renderer.kind] ?? renderer,
  );
  const extra = (overrides as { extraRenderers?: WechatElementRenderer[] }).extraRenderers ?? [];
  return [...base, ...extra];
}

/** 按渲染器顺序执行，等待图片尺寸读取完成。 */
async function runRendererPhase(
  phase: "prepare" | "finalize",
  renderers: WechatElementRenderer[],
  context: WechatRenderContext,
): Promise<void> {
  for (const renderer of renderers) {
    const handler = renderer[phase];
    if (!handler) continue;
    const selector = phase === "finalize"
      ? renderer.finalizeSelector ?? renderer.selector
      : renderer.selector;
    const elements: HTMLElement[] = [];
    if (context.root.matches(selector)) elements.push(context.root);
    elements.push(...Array.from(context.root.querySelectorAll<HTMLElement>(selector)));
    for (const element of elements) {
      if (element.isConnected || element === context.root) await handler(element, context);
    }
  }
}

function themeVariableDeclarations(
  editorVars: Record<string, string>,
  theme: WechatExportTheme,
): string {
  const customVariables = Object.entries(editorVars)
    .filter(([name]) => /^--[a-z0-9-_]+$/i.test(name))
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n");

  return [
    customVariables,
    `--wx-font-family: ${theme.fontFamily};`,
    `--wx-body-color: ${theme.bodyColor};`,
    `--wx-muted-color: ${theme.mutedColor};`,
    `--wx-h2-color: ${theme.h2Color};`,
    `--wx-h3-color: ${theme.h3Color};`,
    `--wx-brand-ink: ${theme.primaryColor};`,
    `--wx-brand-accent: ${editorVars["--brand"] ?? "#ca6093"};`,
    `--wx-divider-color: ${theme.dividerColor};`,
    `--wx-blockquote-border: ${theme.blockquoteBorderColor};`,
    `--wx-body-line-height: ${theme.bodyLineHeight};`,
    `--wx-body-letter-spacing: ${theme.bodyLetterSpacing};`,
    `--wx-soft-surface: ${editorVars["--bg-warm"] ?? "#faf8f9"};`,
  ].filter(Boolean).join("\n");
}

export function buildWechatThemeCss(
  editorVars: Record<string, string>,
  theme: WechatExportTheme,
): string {
  return `
.milkdown .editor {
  ${themeVariableDeclarations(editorVars, theme)}
  ${theme.containerStyle};
  ${theme.bodyFontSize ? `font-size: ${theme.bodyFontSize};` : ""}
}
.milkdown .editor [data-wechat-node="footer"] {
  ${theme.footerStyle};
}
.milkdown .editor p {
  ${theme.bodyFontSize ? `font-size: ${theme.bodyFontSize};` : ""}
  ${theme.bodyParagraphSpacing ? `margin-bottom: ${theme.bodyParagraphSpacing};` : ""}
  ${theme.bodyLineHeight ? `line-height: ${theme.bodyLineHeight};` : ""}
  ${theme.bodyLetterSpacing ? `letter-spacing: ${theme.bodyLetterSpacing};` : ""}
  ${theme.bodyColor ? `color: ${theme.bodyColor};` : ""}
}
`;
}

/**
 * 结构装饰（编号 / 章节标签 / 引用标签）在导出时是真实节点，编辑器里是 ::before。
 * 此处样式与 studio 编辑器的 ::before 视觉对齐，否则预览中退化为普通正文。
 */
function buildStructureDecorationCss(structure?: ArticleStructure): string {
  if (!structure?.numberedHeadings && !structure?.headingLabel && !structure?.quoteLabel) return "";
  return `
.milkdown .editor [data-wechat-node="heading-number"],
.milkdown .editor [data-wechat-node="heading-label"] {
  margin-right: 0.3em;
  opacity: 0.7;
  font-weight: 600;
}
.milkdown .editor [data-wechat-node="quote-label"] {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--wx-brand-ink, var(--wx-brand-accent, #ca6093));
  text-transform: uppercase;
}
`;
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
}

const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * 浏览器把 `border: none; border-left: X` 或 `border-left: none` 序列化成多值简写或
 * none 边的长属性，其中 border-color 是 currentcolor——公众号编辑器解析不了，整条
 * 声明作废后边框退回正文灰色。展开为可见边的单值属性，丢弃 none/hidden 边。
 */
function normalizeBorderShorthands(element: HTMLElement): void {
  const style = element.style;
  const sides = BORDER_SIDES.map((side) => ({
    side,
    width: style.getPropertyValue(`border-${side}-width`),
    style: style.getPropertyValue(`border-${side}-style`),
    color: style.getPropertyValue(`border-${side}-color`),
  }));

  const invisible = (entry: (typeof sides)[number]) => entry.style === "none" || entry.style === "hidden";
  const hasShorthand =
    !!style.getPropertyValue("border-style") ||
    !!style.getPropertyValue("border-width") ||
    !!style.getPropertyValue("border-color");
  if (!hasShorthand && !sides.some(invisible)) return;

  if (!hasShorthand) {
    // 单边 none/hidden 长属性：只删除，其余保持原样
    for (const { side, style: borderStyle } of sides) {
      if (borderStyle !== "none" && borderStyle !== "hidden") continue;
      style.removeProperty(`border-${side}`);
      style.removeProperty(`border-${side}-width`);
      style.removeProperty(`border-${side}-style`);
      style.removeProperty(`border-${side}-color`);
    }
    return;
  }

  const removable = ["border", "border-width", "border-style", "border-color"];
  for (const { side } of sides) {
    removable.push(`border-${side}`, `border-${side}-width`, `border-${side}-style`, `border-${side}-color`);
  }
  for (const property of removable) style.removeProperty(property);

  for (const entry of sides) {
    if (!entry.style || invisible(entry)) continue;
    if (entry.width && entry.color) {
      style.setProperty(`border-${entry.side}`, `${entry.width} ${entry.style} ${entry.color}`);
    } else {
      if (entry.width) style.setProperty(`border-${entry.side}-width`, entry.width);
      style.setProperty(`border-${entry.side}-style`, entry.style);
      if (entry.color) style.setProperty(`border-${entry.side}-color`, entry.color);
    }
  }
}

function sanitizeStyle(element: HTMLElement): void {
  const propertyNames: string[] = [];
  for (let index = 0; index < element.style.length; index += 1) {
    const name = element.style.item(index);
    if (name) propertyNames.push(name);
  }

  for (const property of propertyNames) {
    const value = element.style.getPropertyValue(property).trim();
    const unsafeValue = /(?:url\s*\(|expression\s*\(|javascript:|var\s*\()/i.test(value);
    const unsafeDisplay = property === "display" && !ALLOWED_DISPLAY_VALUES.has(value.toLowerCase());
    if (!ALLOWED_STYLE_PROPERTIES.has(property) || unsafeValue || unsafeDisplay) {
      element.style.removeProperty(property);
    }
  }

  if (!element.style.cssText.trim()) element.removeAttribute("style");
}

function allowedAttributesFor(element: HTMLElement): Set<string> {
  const tagName = element.tagName.toLowerCase();
  if (tagName === "img") return new Set(["style", "src", "data-src", "alt", "width", "height"]);
  if (tagName === "a") return new Set(["style", "href", "title"]);
  if (tagName === "ol") return new Set(["style", "start"]);
  if (tagName === "th" || tagName === "td") return new Set(["style", "colspan", "rowspan", "align"]);
  return new Set(["style"]);
}

function sanitizeImageUrl(element: HTMLElement, attribute: "src" | "data-src"): void {
  const value = element.getAttribute(attribute)?.trim() ?? "";
  if (!value) {
    element.removeAttribute(attribute);
    return;
  }

  if (/^(?:javascript|vbscript):/i.test(value)) {
    element.removeAttribute(attribute);
    return;
  }

  if (/^data:/i.test(value) && !/^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(value)) {
    element.removeAttribute(attribute);
  }
}

function sanitizeTree(root: HTMLElement): void {
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].reverse();
  for (const element of elements) {
    const tagName = element.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tagName)) {
      if (element !== root) element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tagName)) {
      if (element !== root) element.replaceWith(...Array.from(element.childNodes));
      continue;
    }

    const allowedAttributes = allowedAttributesFor(element);
    for (const attribute of Array.from(element.attributes)) {
      if (!allowedAttributes.has(attribute.name)) element.removeAttribute(attribute.name);
    }

    if (tagName === "a") {
      const href = element.getAttribute("href") ?? "";
      if (!/^(?:#|https?:\/\/|mailto:|tel:)/i.test(href)) element.removeAttribute("href");
    }
    if (tagName === "img") {
      sanitizeImageUrl(element, "src");
      sanitizeImageUrl(element, "data-src");
    }
    sanitizeStyle(element);
    normalizeBorderShorthands(element);
  }
}

/** 完成图片缩放后，将文章样式内联为公众号 HTML。 */
export async function renderWechatHtml(input: RenderWechatHtmlInput): Promise<string> {
  const sourceDocument = parseHtml("");
  const compatibilityRoot = sourceDocument.createElement("section");
  compatibilityRoot.className = "milkdown";

  const root = sourceDocument.createElement("section");
  root.className = "editor zzhub-wechat-article";
  root.lang = "zh-CN";
  setNodeKind(root, "article");
  root.innerHTML = input.semanticHtml;
  if (input.structure?.headerImageUrl) {
    const paragraph = sourceDocument.createElement("p");
    const image = sourceDocument.createElement("img");
    image.src = input.structure.headerImageUrl;
    image.alt = "";
    paragraph.appendChild(image);
    root.prepend(paragraph);
  }
  compatibilityRoot.appendChild(root);
  sourceDocument.body.appendChild(compatibilityRoot);

  const references: WechatLinkReference[] = [];
  const pluginRenderers = getCombinedWechatRenderers() as unknown as WechatElementRenderer[];
  const pluginCss = getCombinedDefaultCss();
  const mergedOverrides: WechatRendererOverrides = {
    ...input.renderers,
    extraRenderers: [
      ...((input.renderers as { extraRenderers?: WechatElementRenderer[] })?.extraRenderers ?? []),
      ...pluginRenderers,
    ],
  };
  const renderers = createWechatRendererRegistry(mergedOverrides);
  await runRendererPhase("prepare", renderers, {
    document: sourceDocument,
    root,
    theme: input.theme,
    references,
    structure: input.structure,
    strictImageDecode: input.strictImageDecode ?? true,
  });

  const css = [
    input.baseCss,
    buildWechatThemeCss(input.editorVars ?? {}, input.theme),
    buildStructureDecorationCss(input.structure),
    pluginCss,
    input.customCss ?? "",
  ].filter(Boolean).join("\n");

  const inlinedHtml = juice.inlineContent(compatibilityRoot.outerHTML, css, {
    applyAttributesTableElements: false,
    applyHeightAttributes: false,
    applyStyleTags: false,
    applyWidthAttributes: false,
    inlinePseudoElements: false,
    preserveFontFaces: false,
    preserveImportant: false,
    preserveKeyFrames: false,
    preserveMediaQueries: false,
    preservePseudos: false,
    removeStyleTags: true,
    resolveCSSVariables: true,
    decodeStyleAttributes: true,
  });

  const finalDocument = parseHtml(inlinedHtml);
  const finalRoot = finalDocument.querySelector<HTMLElement>(".zzhub-wechat-article");
  if (!finalRoot) throw new Error("Wechat article root missing after CSS inlining");

  await runRendererPhase("finalize", renderers, {
    document: finalDocument,
    root: finalRoot,
    theme: input.theme,
    references,
    structure: input.structure,
    strictImageDecode: input.strictImageDecode ?? true,
  });
  sanitizeTree(finalRoot);
  return finalRoot.outerHTML;
}
