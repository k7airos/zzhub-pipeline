import { describe, expect, test } from "bun:test";
import { getCombinedWechatRenderers } from "@akairos/milkdown-article-plugins";
import { getWechatPreviewTheme } from "./themes";
import {
  buildWechatThemeCss,
  createWechatRendererRegistry,
  type WechatElementRenderer,
} from "./wechat-renderer";

describe("wechat element renderer registry", () => {
  test("registers every built-in semantic element family in pipeline order", () => {
    expect(createWechatRendererRegistry().map((renderer) => renderer.kind)).toEqual([
      "image",
      "code-block",
      "inline-code",
      "heading",
      "paragraph",
      "emphasis",
      "blockquote",
      "link",
      "list",
      "table",
      "divider",
      "hard-break",
      "article",
    ]);
  });

  test("allows a built-in renderer to be replaced without changing the registry", () => {
    const paragraphOverride: WechatElementRenderer = {
      kind: "paragraph",
      selector: "p[data-custom]",
    };
    const registry = createWechatRendererRegistry({ paragraph: paragraphOverride });

    expect(registry.find((renderer) => renderer.kind === "paragraph")).toBe(paragraphOverride);
    expect(registry).toHaveLength(13);
  });

  test("uses only simple selectors that every DOM implementation matches alike", () => {
    const renderers = [
      ...createWechatRendererRegistry(),
      ...(getCombinedWechatRenderers() as unknown as WechatElementRenderer[]),
    ];
    for (const renderer of renderers) {
      for (const selector of [renderer.selector, renderer.finalizeSelector].filter(Boolean)) {
        expect(`${renderer.kind}: ${selector}`).not.toMatch(/:(not|has|is|where)\(/);
      }
    }
  });

  test("leaves code inside code blocks to the code-block renderer", async () => {
    const inlineCode = createWechatRendererRegistry().find((renderer) => renderer.kind === "inline-code")!;
    const element = (insidePre: boolean) => ({
      dataset: {} as Record<string, string>,
      closest: (selector: string) => (selector === "pre" && insidePre ? {} : null),
    }) as unknown as HTMLElement;
    const blockCode = element(true);
    const inlineNode = element(false);
    await inlineCode.prepare!(blockCode, {} as never);
    await inlineCode.prepare!(inlineNode, {} as never);
    expect(blockCode.dataset.wechatNode).toBeUndefined();
    expect(inlineNode.dataset.wechatNode).toBe("inline-code");
  });

  test("emits compatibility selectors and account theme tokens", () => {
    const theme = getWechatPreviewTheme("default");
    const css = buildWechatThemeCss(theme.editorVars, theme.exportTheme);

    expect(css).toContain(".milkdown .editor");
    expect(css).toContain("--wx-body-line-height: 1.84");
    expect(css).toContain("--wx-h2-color: #1f1b1c");
    expect(css).toContain("--wx-h3-color: #5c5658");
    expect(css).toContain("--wx-brand-ink: #a94473");
    expect(css).toContain('[data-wechat-node="footer"]');
  });
});
