import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

/** Largest whole-pixel font that fits the requested number of wrapped lines.
 * At the minimum size, longer labels keep wrapping instead of losing text.
 */
export function fitLabelFont(
  text: string,
  width: number,
  measure: (text: string, fontSize: number) => number,
  minimum: number,
  maximum: number,
  maxLines = 2,
): number {
  const words = text.trim().split(/\s+/u);
  const fits = (size: number) => {
    let lines = 1, used = 0;
    const space = measure(' ', size);
    for (const word of words) {
      const wordWidth = measure(word, size);
      if (used && used + space + wordWidth > width) { ++lines; used = 0; }
      if (lines > maxLines) return false;
      if (wordWidth <= width) { used += (used ? space : 0) + wordWidth; continue; }
      // Match overflow-wrap:anywhere for identifiers without spaces.
      let fragment = '';
      for (const character of word) {
        if (measure(character, size) > width) return false;
        if (fragment && measure(fragment + character, size) > width) {
          ++lines;
          fragment = '';
          if (lines > maxLines) return false;
        }
        fragment += character;
      }
      used = measure(fragment, size);
    }
    return lines <= maxLines;
  };
  let low = minimum, high = maximum;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

let context: CanvasRenderingContext2D | null;

/** Measure in CSS pixels, independent of the diagram's zoom. Compact nodes
 * claim only the width their label needs; inspector labels use their column.
 */
export function useLabelMetrics(text: string, minimum: number, maximum: number, compact = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ fontSize: minimum, width: 360 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    context ??= document.createElement('canvas').getContext('2d');
    const canvas = context;
    if (!canvas) return;
    let disposed = false;
    const update = () => {
      if (disposed) return;
      const css = getComputedStyle(element);
      const measure = (label: string, size: number) => {
        canvas.font = `${css.fontWeight} ${size}px ${css.fontFamily}`;
        return canvas.measureText(label).width;
      };
      const width = compact
        ? Math.ceil(Math.max(280, Math.min(440, measure(text, maximum) + 44)))
        : element.clientWidth;
      const available = compact ? width - 44 : width - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      if (available <= 0) return;
      const fontSize = fitLabelFont(text, available, measure, minimum, maximum);
      setMetrics(previous => previous.fontSize === fontSize && previous.width === width ? previous : { fontSize, width });
    };
    update();
    const observer = new ResizeObserver(update);
    if (!compact) observer.observe(element);
    document.fonts.ready.then(update);
    document.fonts.addEventListener('loadingdone', update);
    return () => {
      disposed = true;
      observer.disconnect();
      document.fonts.removeEventListener('loadingdone', update);
    };
  }, [text, minimum, maximum, compact]);
  return { ref, ...metrics };
}

export function AdaptiveText({ text, className, minimum = 18, maximum = 20 }: {
  text: string;
  className: string;
  minimum?: number;
  maximum?: number;
}) {
  const { ref, fontSize } = useLabelMetrics(text, minimum, maximum);
  return <div className={className} ref={ref} style={{ fontSize } as CSSProperties} title={text}>{text}</div>;
}
