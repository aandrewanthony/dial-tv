import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

const GAP = 14;

/**
 * Window-scrolled virtual grid: only the visible rows of posters are in the DOM, so a library
 * of 50k+ titles scrolls smoothly. Columns adapt to the container width.
 */
export function VirtualGrid<T>({ items, minWidth = 150, extraHeight = 54, render, getKey, label }: {
  items: T[];
  minWidth?: number;
  /** Height below the 2:3 poster (title lines). */
  extraHeight?: number;
  render: (item: T) => ReactNode;
  getKey: (item: T) => string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const [offset, setOffset] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth || 1000);
      setOffset(el.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(2, Math.floor((width + GAP) / (minWidth + GAP)));
  const cardW = (width - GAP * (cols - 1)) / cols;
  const rowH = Math.round(cardW * 1.5 + extraHeight + GAP);
  const rows = Math.ceil(items.length / cols);

  const virt = useWindowVirtualizer({ count: rows, estimateSize: () => rowH, overscan: 3, scrollMargin: offset });
  // Row height depends on width: re-measure when it changes.
  useLayoutEffect(() => virt.measure(), [rowH, cols]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="tvVGrid" role="list" aria-label={label} style={{ height: virt.getTotalSize(), position: 'relative' }}>
      {virt.getVirtualItems().map((vr) => (
        <div
          key={vr.key}
          className="tvVRow"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vr.start - offset}px)`, display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}
        >
          {items.slice(vr.index * cols, vr.index * cols + cols).map((it) => <div role="listitem" key={getKey(it)}>{render(it)}</div>)}
        </div>
      ))}
    </div>
  );
}
