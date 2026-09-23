import { registerCustomTheme } from '@pierre/diffs';

interface Base16 {
  readonly name: string;
  readonly base00: string;
  readonly code: string;
  readonly base01: string;
  readonly base02: string;
  readonly base03: string;
  readonly base04: string;
  readonly base05: string;
  readonly base08: string;
  readonly base09: string;
  readonly base0A: string;
  readonly base0B: string;
  readonly base0C: string;
  readonly base0D: string;
  readonly base0E: string;
  readonly base0F: string;
}

export const palettes = {
  'base16-tomorrow-night': {
    name: 'base16-tomorrow-night',
    base00: '#1d1f21',
    code: '#101112',
    base01: '#282a2e',
    base02: '#373b41',
    base03: '#969896',
    base04: '#b4b7b4',
    base05: '#c5c8c6',
    base08: '#cc6666',
    base09: '#de935f',
    base0A: '#f0c674',
    base0B: '#b5bd68',
    base0C: '#8abeb7',
    base0D: '#81a2be',
    base0E: '#b294bb',
    base0F: '#a3685a',
  },
  'base16-tomorrow-night-eighties': {
    name: 'base16-tomorrow-night-eighties',
    base00: '#2d2d2d',
    code: '#111111',
    base01: '#393939',
    base02: '#515151',
    base03: '#999999',
    base04: '#b4b7b4',
    base05: '#cccccc',
    base08: '#f2777a',
    base09: '#f99157',
    base0A: '#ffcc66',
    base0B: '#99cc99',
    base0C: '#66cccc',
    base0D: '#6699cc',
    base0E: '#cc99cc',
    base0F: '#a3685a',
  },
} as const satisfies Record<string, Base16>;

export type PaletteName = keyof typeof palettes;

const toTheme = (p: Base16) => ({
  name: p.name,
  type: 'dark' as const,
  colors: {
    'editor.background': p.code,
    'editor.foreground': p.base05,
  },
  tokenColors: [
    { settings: { foreground: p.base05, background: p.code } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: p.base03, fontStyle: 'italic' } },
    { scope: ['string', 'string.template', 'markup.inserted'], settings: { foreground: p.base0B } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], settings: { foreground: p.base09 } },
    { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: p.base0E } },
    { scope: ['keyword.operator', 'punctuation', 'meta.brace', 'punctuation.separator'], settings: { foreground: p.base05 } },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call', 'variable.function'], settings: { foreground: p.base0D } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'], settings: { foreground: p.base0A } },
    { scope: ['variable', 'variable.other', 'variable.parameter', 'meta.definition.variable'], settings: { foreground: p.base05 } },
    { scope: ['variable.other.property', 'meta.object-literal.key', 'support.variable.property', 'entity.other.attribute-name'], settings: { foreground: p.base08 } },
    { scope: ['entity.name.tag', 'meta.tag.sgml', 'markup.deleted'], settings: { foreground: p.base08 } },
    { scope: ['string.regexp', 'constant.character.escape'], settings: { foreground: p.base0C } },
    { scope: ['variable.language', 'variable.language.this'], settings: { foreground: p.base08 } },
    { scope: ['entity.name.namespace', 'entity.name.module'], settings: { foreground: p.base0A } },
    { scope: ['markup.heading', 'entity.name.section'], settings: { foreground: p.base0D, fontStyle: 'bold' } },
  ],
});

export const uiVars = (p: Base16): Record<string, string> => ({
  '--bg': p.base00,
  '--code': p.code,
  '--canvas': `color-mix(in srgb, ${p.base00} 85%, black)`,
  '--panel': `color-mix(in srgb, ${p.base00} 60%, ${p.base01})`,
  '--panel-2': p.base01,
  '--border': p.base02,
  '--border-muted': `color-mix(in srgb, ${p.base01} 50%, ${p.base02})`,
  '--text': p.base05,
  '--text-strong': `color-mix(in srgb, ${p.base05} 70%, white)`,
  '--muted': p.base03,
  '--accent': p.base0D,
  '--add': p.base0B,
  '--del': p.base08,
  '--note': p.base0A,
  '--viewed': p.base0C,
});

export const registerThemes = () =>
  Object.values(palettes).forEach((palette) =>
    registerCustomTheme(palette.name, () => Promise.resolve(toTheme(palette) as never)),
  );

export const diffCss = (p: Base16) => `
  :host {
    --diffs-dark-bg: ${p.code};
    --diffs-bg-context-override: ${p.code};
    --diffs-bg-context-gutter-override: ${p.code};
    --diffs-bg-buffer-override: color-mix(in lab, ${p.code} 94%, ${p.base05});
    --diffs-bg-separator-override: color-mix(in lab, ${p.code} 90%, ${p.base05});
    --diffs-addition-color: ${p.base0B};
    --diffs-deletion-color: ${p.base08};
    --diffs-bg-addition-override: color-mix(in lab, ${p.code} 88%, ${p.base0B});
    --diffs-bg-deletion-override: color-mix(in lab, ${p.code} 88%, ${p.base08});
    --diffs-bg-addition-emphasis-override: color-mix(in lab, ${p.code} 76%, ${p.base0B});
    --diffs-bg-deletion-emphasis-override: color-mix(in lab, ${p.code} 76%, ${p.base08});
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    --diffs-font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  }
`;
