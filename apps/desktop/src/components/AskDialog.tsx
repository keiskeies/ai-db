import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * 应用自己的确认/输入弹层。window.confirm/prompt 由系统绘制：底色、字体、
 * 按钮语言都跟主题无关，在暗色面板上格外刺眼，且会阻塞事件循环。
 */
export interface AskOptions {
  title?: string;
  message: string;
  /** 危险操作的补充说明，比如会清空哪些数据。 */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions extends AskOptions {
  value?: string;
  placeholder?: string;
}

interface AskState extends PromptOptions {
  id: number;
  kind: 'confirm' | 'prompt';
}

let active: { state: AskState; resolve: (value: string | null) => void } | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return active?.state ?? null;
}

function show(state: AskState, resolve: (value: string | null) => void) {
  // 同一时刻只保留最后一个：连点删除时不该堆出几层一样的确认框。
  if (active) {
    const previous = active;
    active = null;
    previous.resolve(null);
  }
  active = { state, resolve };
  emit();
}

function settle(value: string | null) {
  const pending = active;
  if (!pending) return;
  active = null;
  emit();
  pending.resolve(value);
}

/** 破坏性动作的确认框；返回 false 表示用户放弃。 */
export function askConfirm(options: string | AskOptions): Promise<boolean> {
  const opts = typeof options === 'string' ? { message: options } : options;
  return new Promise<boolean>((resolve) => {
    show({ id: ++seq, kind: 'confirm', ...opts }, (value) => resolve(value !== null));
  });
}

/** 单行输入框；返回 null 表示取消，空串是用户真的清空了值。 */
export function askPrompt(options: string | PromptOptions): Promise<string | null> {
  const opts = typeof options === 'string' ? { message: options } : options;
  return new Promise<string | null>((resolve) => {
    show({ id: ++seq, kind: 'prompt', ...opts }, resolve);
  });
}

export function AskHost() {
  const state = useSyncExternalStore(subscribe, snapshot);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!state) return;
    if (state.kind === 'prompt') inputRef.current?.focus();
    else confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') settle(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state?.id]);

  if (!state) return null;
  const submit = () => settle(state.kind === 'prompt' ? (inputRef.current?.value ?? '') : 'ok');

  return (
    <div className="overlay ask" onMouseDown={(e) => e.target === e.currentTarget && settle(null)} data-testid="ask-dialog">
      <form
        className={`modal ask-modal ${state.danger ? 'danger' : ''}`}
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="ask-body">
          {state.danger ? <span className="ask-icon"><AlertTriangle size={16} /></span> : null}
          <div className="ask-text">
            {state.title ? <h2>{state.title}</h2> : null}
            <p className="ask-message">{state.message}</p>
            {state.detail ? <p className="ask-detail">{state.detail}</p> : null}
            {state.kind === 'prompt' ? (
              <input
                ref={inputRef}
                className="input ask-input"
                data-testid="ask-input"
                defaultValue={state.value ?? ''}
                placeholder={state.placeholder}
              />
            ) : null}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" data-testid="ask-cancel" onClick={() => settle(null)}>
            {state.cancelLabel ?? '取消'}
          </button>
          <button ref={confirmRef} type="submit" className={`btn ${state.danger ? 'danger' : 'primary'}`} data-testid="ask-confirm">
            {state.confirmLabel ?? '确定'}
          </button>
        </div>
      </form>
    </div>
  );
}
