import { Check, ChevronDown, Copy, Info, X } from 'lucide-react';
import {
  Children,
  isValidElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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

/**
 * 下拉项/分组只是给 Select 读取的声明式标记，本身不产生 DOM：
 * 展开的菜单由 Select 用主题自己画，原生 select 的弹层是系统渲染的，换肤跟不上。
 */
export function Option({ value, children, disabled }: { value: string | number; children?: ReactNode; disabled?: boolean }) {
  return null;
}

export function OptGroup({ label, children }: { label: string; children?: ReactNode }) {
  return null;
}

export interface SelectChangeEvent {
  target: { value: string };
}

type SelectItem = { kind: 'item'; value: string; label: ReactNode; disabled: boolean };
type SelectNode = SelectItem | { kind: 'group'; label: ReactNode };

function readSelectNodes(children: ReactNode, out: SelectNode[] = []): SelectNode[] {
  for (const node of Children.toArray(children)) {
    if (!isValidElement(node)) continue;
    const props = node.props as Record<string, unknown>;
    if (node.type === OptGroup) {
      out.push({ kind: 'group', label: props.label as ReactNode });
      readSelectNodes(props.children as ReactNode, out);
    } else if (node.type === Option) {
      const value = String(props.value ?? '');
      out.push({ kind: 'item', value, label: (props.children as ReactNode) ?? value, disabled: Boolean(props.disabled) });
    }
  }
  return out;
}

interface SelectProps {
  value: string | number;
  onChange: (event: SelectChangeEvent) => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
  placeholder?: string;
  disabled?: boolean;
  [dataAttribute: `data-${string}`]: unknown;
}

/** 与原生 select 同签名的自定义下拉：value/onChange/data-testid 照旧，弹层走主题样式。 */
export function Select({ value: rawValue, onChange, children, className = '', style, title, placeholder, disabled = false, ...rest }: SelectProps) {
  const value = String(rawValue);
  const nodes = useMemo(() => readSelectNodes(children), [children]);
  const items = useMemo(() => nodes.filter((node): node is SelectItem => node.kind === 'item'), [nodes]);
  const selected = items.find((item) => item.value === value);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [box, setBox] = useState({ left: 0, top: 0, minWidth: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? Math.max(rect.width, 160);
    const height = menu?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const fitsBelow = rect.bottom + 4 + height <= window.innerHeight - 8;
    const top = height && !fitsBelow ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    setBox((prev) => (prev.left === left && prev.top === top && prev.minWidth === rect.width ? prev : { left, top, minWidth: rect.width }));
  }, []);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || disabled) return;
    const rect = trigger.getBoundingClientRect();
    setBox({ left: rect.left, top: rect.bottom + 4, minWidth: rect.width });
    setCursor(Math.max(0, items.findIndex((item) => item.value === value)));
    setOpen(true);
  }, [disabled, items, value]);

  const choose = useCallback(
    (next: string) => {
      setOpen(false);
      if (next !== value) onChange({ target: { value: next } });
      triggerRef.current?.focus();
    },
    [onChange, value],
  );

  useLayoutEffect(() => {
    if (!open) return;
    place();
    menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const step = (from: number, direction: number) => {
      for (let index = from + direction; index >= 0 && index < items.length; index += direction) {
        if (!items[index].disabled) return index;
      }
      return from;
    };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((prev) => step(prev, event.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setCursor(event.key === 'Home' ? 0 : Math.max(0, items.length - 1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = items[cursor];
      if (item && !item.disabled) choose(item.value);
    }
  };

  let itemCursor = -1;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select select-trigger ${open ? 'open' : ''} ${className}`}
        style={style}
        title={title}
        disabled={disabled}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openMenu();
          }
        }}
        {...rest}
      >
        <span className="select-label">{selected ? selected.label : value || placeholder || ''}</span>
        <ChevronDown size={11} className="select-caret" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="select-menu"
          style={{ left: box.left, top: box.top, minWidth: box.minWidth }}
          role="listbox"
          tabIndex={-1}
          autoFocus
          aria-label={title}
          onKeyDown={onMenuKeyDown}
          data-testid={typeof rest['data-testid'] === 'string' ? `${rest['data-testid']}-menu` : undefined}
        >
          {nodes.map((node, index) => {
            if (node.kind === 'group') return <div key={`g_${index}`} className="select-group">{node.label}</div>;
            itemCursor += 1;
            const active = itemCursor === cursor;
            const isSelected = node.value === value;
            return (
              <button
                key={`${node.value}_${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={node.disabled}
                data-value={node.value}
                className={`select-menu-item ${isSelected ? 'active' : ''} ${active ? 'cursor' : ''}`}
                onClick={() => choose(node.value)}
              >
                <span className="select-item-label truncate">{node.label}</span>
                {isSelected ? <Check size={11} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </>
  );
}

/**
 * 可输入下拉（combobox）：datalist 的建议列表由系统绘制，暗色面板上会弹白底，
 * 且不吃主题。这里保留自由输入，建议列表换成应用自绘。
 */
export function Combo({
  value,
  onChange,
  options,
  className = '',
  style,
  placeholder,
  disabled = false,
  ...rest
}: {
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  options: string[];
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  [dataAttribute: `data-${string}`]: unknown;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [box, setBox] = useState({ left: 0, top: 0, minWidth: 0 });

  const matches = useMemo(() => {
    const query = value.trim().toLowerCase();
    const list = query ? options.filter((option) => option.toLowerCase().includes(query)) : options;
    return list.slice(0, 60);
  }, [options, value]);

  const place = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const menu = menuRef.current;
    const width = menu?.offsetWidth ?? rect.width;
    const height = menu?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const fitsBelow = rect.bottom + 4 + height <= window.innerHeight - 8;
    const top = height && !fitsBelow ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
    setBox((prev) => (prev.left === left && prev.top === top && prev.minWidth === rect.width ? prev : { left, top, minWidth: rect.width }));
  }, []);

  const commit = useCallback(
    (next: string) => {
      setOpen(false);
      onChange({ target: { value: next } });
      inputRef.current?.focus();
    },
    [onChange],
  );

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (inputRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  const show = () => {
    if (disabled || !matches.length) return;
    setCursor(0);
    setOpen(true);
  };

  return (
    <div className={`combo ${open ? 'open' : ''} ${className}`} style={style}>
      <input
        ref={inputRef}
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          onChange(event);
          show();
        }}
        onFocus={show}
        onKeyDown={(event) => {
          if (!open) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') show();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor((prev) => Math.min(matches.length - 1, Math.max(0, prev + (event.key === 'ArrowDown' ? 1 : -1))));
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            const picked = matches[cursor];
            if (picked) commit(picked);
          }
        }}
        {...rest}
      />
      <ChevronDown size={11} className="combo-caret" />
      {open ? (
        <div ref={menuRef} className="select-menu combo-menu" style={{ left: box.left, top: box.top, minWidth: box.minWidth }} role="listbox">
          {matches.map((option, index) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              className={`select-menu-item ${option === value ? 'active' : ''} ${index === cursor ? 'cursor' : ''}`}
              // 按下不抢焦点：否则输入框先失焦、菜单被关，这次点击就落空了
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(option)}
            >
              <span className="select-item-label truncate">{option}</span>
              {option === value ? <Check size={11} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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
