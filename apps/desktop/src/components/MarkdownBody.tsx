import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './ui';

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const text = String(children ?? '').replace(/\n$/, '');
  return (
    <pre>
      <code className={className}>{text}</code>
      <span className="code-copy">
        <CopyButton text={text} />
      </span>
    </pre>
  );
}

/** Markdown 渲染单独成块：react-markdown 加 micromark 约 160KB，只有 Agent 出正文时才用得上。 */
export default function MarkdownBody({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }: any) => {
          const isBlock = String(children ?? '').includes('\n') || Boolean(className);
          if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
          return <code>{children}</code>;
        },
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
