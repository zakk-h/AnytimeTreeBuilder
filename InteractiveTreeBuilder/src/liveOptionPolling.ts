import type { NativeNodeView } from './nativeGraph';

// Poll 15 times at 2-second intervals (through 30s), then every 10 seconds.
// Stop before 5 minutes of continuous selection. Return an absolute offset
// rather than an interval so slow requests do not cause timer drift.
export function nextLiveNodeRefreshAt(elapsedMs: number): number | null {
  const elapsed = Math.max(0, elapsedMs);
  const next = elapsed < 30_000
    ? (Math.floor(elapsed / 2_000) + 1) * 2_000
    : 30_000 + (Math.floor((elapsed - 30_000) / 10_000) + 1) * 10_000;
  return next < 300_000 ? next : null;
}

// Check only information that affects the displayed options/budget. Native
// query IDs, checkpoint counters, and visit counts change even without any
// visible graph change, so comparing the full response would rerender needlessly.
export function nativeNodeViewSignature(view: NativeNodeView): string {
  return JSON.stringify([
    view.root_budget, view.root_minimum, view.root_size,
    view.summaries, view.options,
  ]);
}
