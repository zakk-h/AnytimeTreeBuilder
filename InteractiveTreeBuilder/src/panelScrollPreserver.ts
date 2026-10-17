const PANEL_SELECTOR = '.panel';
const CHOICE_PANEL_SELECTOR = '.panel-section.choice-panel';
const ENTER_THRESHOLD_SELECTOR = '.feature-summary-card';
const EXIT_THRESHOLD_SELECTOR = '.back-button';
const ANCHOR_GAP = 8;

function capturedChoicePanelTop(
  panel: HTMLElement,
  choicePanel: HTMLElement,
  scrollTop: number,
): number {
  const panelRect = panel.getBoundingClientRect();
  const choiceRect = choicePanel.getBoundingClientRect();

  // Capture this before React changes the menu. Once the swap starts, the
  // browser may clamp scrollTop because the content becomes shorter, so using
  // post-swap geometry can feed that clamp back into the anchor calculation.
  return Math.max(
    0,
    scrollTop + choiceRect.top - panelRect.top - ANCHOR_GAP,
  );
}

function restoreScrollPosition(
  panel: HTMLElement,
  choicePanel: HTMLElement,
  targetTop: number,
) {
  if (!panel.isConnected || !choicePanel.isConnected) return;

  // A compact threshold/range chooser can be much shorter than the feature
  // list it replaces. If the whole panel becomes too short to reach targetTop,
  // extend only this section enough to make that exact scroll position valid.
  const requiredScrollHeight = targetTop + panel.clientHeight;
  const deficit = requiredScrollHeight - panel.scrollHeight;

  if (deficit > 0) {
    const currentHeight = choicePanel.getBoundingClientRect().height;
    choicePanel.style.minHeight = `${Math.ceil(currentHeight + deficit + 2)}px`;
  }

  panel.scrollTop = targetTop;
}

function preserveThroughMenuSwap(
  panel: HTMLElement,
  choicePanel: HTMLElement,
  targetTop: number,
) {
  const restore = () =>
    restoreScrollPosition(panel, choicePanel, targetTop);

  queueMicrotask(restore);

  let frames = 0;
  const restoreFrame = () => {
    restore();
    frames += 1;
    if (frames < 4) requestAnimationFrame(restoreFrame);
  };
  requestAnimationFrame(restoreFrame);

  window.setTimeout(restore, 120);
  window.setTimeout(restore, 300);
}

document.addEventListener(
  'click',
  (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const entering = target.closest(ENTER_THRESHOLD_SELECTOR);
    const exiting = target.closest(EXIT_THRESHOLD_SELECTOR);
    if (!entering && !exiting) return;

    const panel = target.closest(PANEL_SELECTOR);
    const choicePanel = target.closest(CHOICE_PANEL_SELECTOR);
    if (!(panel instanceof HTMLElement) || !(choicePanel instanceof HTMLElement)) {
      return;
    }

    const currentTop = panel.scrollTop;

    // IMPORTANT: compute the anchor while the old feature menu is still fully
    // present. For entering a threshold chooser, preserve the current position
    // unless that would leave the top of the choice section above the viewport.
    const sectionTop = capturedChoicePanelTop(panel, choicePanel, currentTop);
    const targetTop = entering
      ? Math.min(currentTop, sectionTop)
      : currentTop;

    // Clear any height retained by the previous compact chooser only after the
    // target has been captured. Browser clamping after this point is harmless:
    // every restore uses the fixed pre-swap targetTop above.
    choicePanel.style.minHeight = '';

    preserveThroughMenuSwap(panel, choicePanel, targetTop);
  },
  true,
);
