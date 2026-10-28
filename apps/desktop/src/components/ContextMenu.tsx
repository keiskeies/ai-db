import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../store';

/**
 * 全局右键菜单宿主：所有区域共用一份，样式与交互只有一处。
 * 定位在视口内收边，避免贴边弹出被裁掉。
 */
export function ContextMenuHost() {
  const menu = useApp((s) => s.contextMenu);
  const close = useApp((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setPos({ x: menu?.x ?? 0, y: menu?.y ?? 0 });
  }, [menu]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    if (x !== pos.x || y !== pos.y) setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [menu, pos.x, pos.y]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu, close]);

  if (!menu) return null;
  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} data-testid="context-menu" role="menu">
      {menu.items.map((item, index) =>
        item.sep ? (
          <div key={`sep_${index}`} className="context-sep" />
        ) : (
          <button
            key={`${item.label}_${index}`}
            className={`context-item ${item.danger ? 'danger' : ''}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onClick?.();
            }}
          >
            {item.icon ?? <span style={{ width: 12, flex: '0 0 12px' }} />}
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
