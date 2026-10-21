import type { ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins = [remarkGfm];

const ExternalLink = ({ node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) => (
  <a {...props} target="_blank" rel="noreferrer" />
);

const components = { a: ExternalLink };

export const RichText = ({ text, className }: { text: string; className?: string }) => (
  <div className={className === undefined ? 'rich-text' : `rich-text ${className}`}>
    <Markdown remarkPlugins={plugins} components={components}>
      {text}
    </Markdown>
  </div>
);
