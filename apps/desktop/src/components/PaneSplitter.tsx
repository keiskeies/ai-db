import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

interface PaneSplitterProps {
  /** left：拖的是左栏右边框，向右变宽；right：拖的是右栏左边框，向左变宽 */
  side: 'left' | 'right';
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
  testId: string;
}

export function PaneSplitter({ side, width, min, max, onChange, onCommit, testId }: PaneSplitterProps) {
  const latest = useRef(width);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const el = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    latest.current = width;
    el.setPointerCapture(event.pointerId);
    el.classList.add('dragging');

    const move = (ev: PointerEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      const next = Math.round(Math.min(max, Math.max(min, startWidth + delta)));
      latest.current = next;
      onChange(next);
    };
    const finish = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      onCommit(latest.current);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  };

  return (
    <div
      className="pane-splitter"
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={() => {
        const fallback = side === 'left' ? 244 : 384;
        latest.current = fallback;
        onChange(fallback);
        onCommit(fallback);
      }}
      title="拖动调整宽度，双击恢复默认"
    />
  );
}
