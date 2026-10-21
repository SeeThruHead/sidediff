import { File } from '@pierre/diffs/react';
import { type ComponentProps, type ReactNode, createContext, useContext, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { type PaletteName, diffCss, palettes } from './themes';

const plugins = [remarkGfm];

export const PaletteContext = createContext<PaletteName>('base16-tomorrow-night-eighties');

const extensions: Readonly<Record<string, string>> = {
  ts: 'ts',
  typescript: 'ts',
  tsx: 'tsx',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  json: 'json',
  sql: 'sql',
  sh: 'sh',
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  html: 'html',
  diff: 'diff',
  md: 'md',
  markdown: 'md',
  py: 'py',
  python: 'py',
  toml: 'toml',
};

type MarkdownNode = {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly properties?: { readonly className?: unknown };
  readonly children?: readonly MarkdownNode[];
};

const textOf = (node: MarkdownNode): string =>
  node.value ?? (node.children ?? []).map(textOf).join('');

const languageOf = (code: MarkdownNode) => {
  const classes = code.properties?.className;
  if (!Array.isArray(classes)) return undefined;

  const tag = classes.find((name): name is string => typeof name === 'string' && name.startsWith('language-'));
  return tag?.slice('language-'.length).toLowerCase();
};

const fencedCode = (node: MarkdownNode | undefined) => {
  const code = node?.children?.find((child) => child.tagName === 'code');
  if (code === undefined) return undefined;

  const extension = extensions[languageOf(code) ?? ''];
  if (extension === undefined) return undefined;

  return { extension, contents: textOf(code).replace(/\n$/, '') };
};

const Snippet = ({ extension, contents }: { extension: string; contents: string }) => {
  const palette = useContext(PaletteContext);
  const options = useMemo(
    () => ({
      theme: palette,
      themeType: 'dark' as const,
      overflow: 'wrap' as const,
      disableFileHeader: true,
      disableLineNumbers: true,
      unsafeCSS: diffCss(palettes[palette]),
    }),
    [palette],
  );

  return (
    <div className="rich-text-code">
      <File file={{ name: `snippet.${extension}`, contents }} disableWorkerPool options={options} />
    </div>
  );
};

const CodeBlock = ({ node, children, ...props }: ComponentProps<'pre'> & { node?: MarkdownNode; children?: ReactNode }) => {
  const snippet = fencedCode(node);
  if (snippet === undefined) return <pre {...props}>{children}</pre>;

  return <Snippet extension={snippet.extension} contents={snippet.contents} />;
};

const ExternalLink = ({ node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => (
  <a {...props} target="_blank" rel="noreferrer" />
);

const components = { a: ExternalLink, pre: CodeBlock };

export const RichText = ({ text, className }: { text: string; className?: string }) => (
  <div className={className === undefined ? 'rich-text' : `rich-text ${className}`}>
    <Markdown remarkPlugins={plugins} components={components}>
      {text}
    </Markdown>
  </div>
);
