import { Check, Copy, Info, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Risk } from '@aidb/core';
import { useApp } from '../store';

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide,
  className = '',
  icon,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>
            {icon}
            {title}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function RiskBadge({ risk }: { risk?: Risk | string }) {
  if (!risk) return null;
  const label: Record<string, string> = { read: 'READ', write: 'WRITE', ddl: 'DDL', destructive: 'DANGER', dynamic: 'SQL' };
  return <span className={`badge ${risk}`}>{label[risk] ?? risk}</span>;
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div>
        <div className="icon">{icon}</div>
        <h3>{title}</h3>
        {children ? <p>{children}</p> : null}
      </div>
    </div>
  );
}

export function CopyButton({ text, small = true }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`btn ghost ${small ? 'small' : ''}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard may be blocked */
        }
      }}
      title="copy"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

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

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
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
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="t-icon">{t.kind === 'success' ? <Check size={15} /> : t.kind === 'error' ? <X size={15} /> : <Info size={15} />}</span>
          <div className="t-body">
            <div className="t-title">{t.message}</div>
            {t.detail ? <div className="t-detail">{t.detail}</div> : null}
          </div>
          <button className="icon-btn" onClick={() => dismiss(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
