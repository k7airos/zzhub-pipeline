export interface WechatExportTheme {
  containerStyle: string;
  footerText: string;
  footerStyle: string;
  fontFamily: string;
  bodyColor: string;
  mutedColor: string;
  /** Major section heading (H2); slightly deeper than body */
  h2Color: string;
  /** In-section heading (H3); between body and muted */
  h3Color: string;
  primaryColor: string;
  dividerColor: string;
  blockquoteBorderColor: string;
  bodyLineHeight: string;
  bodyLetterSpacing: string;
  /** 正文字号与段落间距；未设置时沿用共享样式。 */
  bodyFontSize?: string;
  bodyParagraphSpacing?: string;
}

export interface WechatPreviewTheme {
  name: string;
  account: string;
  editorVars: Record<string, string>;
  exportTheme: WechatExportTheme;
}

const BASE_EDITOR_VARS: Record<string, string> = {
  "--background": "0 0% 100%",
  "--foreground": "240 10% 3.9%",
  "--card": "0 0% 100%",
  "--card-foreground": "240 10% 3.9%",
  "--muted": "240 4.8% 95.9%",
  "--muted-foreground": "240 3.8% 46.1%",
  "--primary-foreground": "0 0% 100%",
  "--border": "240 5.9% 90%",
};

function buildContainerStyle(options: {
  background: string;
  color: string;
  fontFamily: string;
  lineHeight?: string;
  letterSpacing?: string;
}): string {
  return [
    "max-width: 100%",
    "margin: 0",
    "padding: 10px 4px 30px",
    `background: ${options.background}`,
    "box-sizing: border-box",
    `font-family: ${options.fontFamily}`,
    "font-size: 16px",
    `color: ${options.color}`,
    "overflow-wrap: break-word",
    "word-break: break-word",
    `line-height: ${options.lineHeight ?? "1.84"}`,
    `letter-spacing: ${options.letterSpacing ?? "0.012em"}`,
    "-webkit-text-size-adjust: 100%",
    "text-size-adjust: 100%",
  ].join("; ");
}

function buildFooterStyle(color: string): string {
  return [
    "margin-top: 32px",
    "text-align: center",
    "font-size: 12px",
    "line-height: 1.6",
    "letter-spacing: 0.08em",
    `color: ${color}`,
  ].join("; ");
}

const THEMES: Record<string, WechatPreviewTheme> = {
  default: {
    name: "sage-journal",
    account: "default",
    editorVars: {
      ...BASE_EDITOR_VARS,
      "--primary": "220 9% 10%",
      "--ring": "220 9% 10%",
      "--accent": "210 14% 96%",
      "--accent-foreground": "220 9% 10%",
      "--muted": "210 14% 96%",
      "--muted-foreground": "215 8% 42%",
      "--border": "220 10% 86%",
      "--brand": "#ca6093",
      "--brand-soft": "#ca6093",
      "--brand-bg": "rgba(202, 96, 147, 0.08)",
      "--brand-bg-deep": "rgba(202, 96, 147, 0.12)",
      "--text": "#292526",
      "--text-soft": "#6f696b",
      "--text-mid": "#4d484a",
      "--divider": "#e2dcdf",
      "--bg-page": "#ffffff",
      "--bg-warm": "#faf7f8",
    },
    exportTheme: {
      containerStyle: buildContainerStyle({
        background: "#ffffff",
        color: "#292526",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif",
        lineHeight: "1.84",
        letterSpacing: "0.012em",
      }),
      footerText: "公众号 · 早早集市",
      footerStyle: buildFooterStyle("#716a6d"),
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif",
      bodyColor: "#292526",
      mutedColor: "#6f696b",
      h2Color: "#1f1b1c",
      h3Color: "#5c5658",
      primaryColor: "#a94473",
      dividerColor: "#e2dcdf",
      blockquoteBorderColor: "#ca6093",
      bodyLineHeight: "1.84",
      bodyLetterSpacing: "0.012em",
    },
  },
  ancientone: {
    name: "rose-ledger",
    account: "ancientone",
    editorVars: {
      ...BASE_EDITOR_VARS,
      "--primary": "337 38% 58%",
      "--ring": "337 38% 58%",
      "--accent": "337 30% 96%",
      "--accent-foreground": "337 28% 22%",
      "--muted": "338 25% 97%",
      "--border": "337 20% 88%",
      "--brand": "#b86f86",
      "--brand-soft": "#b86f86",
      "--brand-bg": "rgba(184, 111, 134, 0.08)",
      "--brand-bg-deep": "rgba(184, 111, 134, 0.12)",
      "--text": "#30292b",
      "--text-soft": "#756b6e",
      "--text-mid": "#534a4d",
      "--divider": "#dfd7da",
      "--bg-page": "#fefefe",
      "--bg-warm": "#faf7f8",
    },
    exportTheme: {
      containerStyle: buildContainerStyle({
        background: "#fefefe",
        color: "#30292b",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif",
        lineHeight: "1.85",
        letterSpacing: "0.015em",
      }),
      footerText: "公众号 · 古一软件",
      footerStyle: buildFooterStyle("#756b6e"),
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC', sans-serif",
      bodyColor: "#30292b",
      mutedColor: "#756b6e",
      h2Color: "#241f21",
      h3Color: "#61585b",
      primaryColor: "#8f4d63",
      dividerColor: "#dfd7da",
      blockquoteBorderColor: "#b86f86",
      bodyLineHeight: "1.85",
      bodyLetterSpacing: "0.015em",
    },
  },
};

function definedValues<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as Partial<T>;
}

export function getWechatPreviewTheme(
  account: string,
  overrides?: {
    editorVars?: Record<string, string>;
    exportTheme?: Partial<WechatExportTheme>;
  },
): WechatPreviewTheme {
  const base = THEMES[account] ?? THEMES.default;
  if (!overrides) return base;

  const hasEditorVars = overrides.editorVars && Object.keys(overrides.editorVars).length > 0;
  const hasExportTheme = overrides.exportTheme && Object.keys(definedValues(overrides.exportTheme)).length > 0;

  return {
    ...base,
    editorVars: hasEditorVars ? { ...base.editorVars, ...overrides.editorVars } : base.editorVars,
    exportTheme: hasExportTheme ? { ...base.exportTheme, ...definedValues(overrides.exportTheme!) } : base.exportTheme,
  };
}

export function getWechatPreviewStyleName(account: string): string {
  return getWechatPreviewTheme(account).name;
}
