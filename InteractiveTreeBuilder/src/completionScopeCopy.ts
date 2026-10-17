const COMPLETION_LABEL_ID = 'arborenum-completion-label';
const CONSTRAINT_MODAL_ID = 'arborenum-constrained-completion-modal';

function setText(element: Element | null, text: string) {
  if (element && element.textContent !== text) {
    element.textContent = text;
  }
}

function updateCompletionScopeCopy() {
  const completionLabel = document.getElementById(COMPLETION_LABEL_ID);
  setText(completionLabel?.querySelector('b') ?? null, 'Complete subtree');
  setText(
    completionLabel?.querySelector('span') ?? null,
    'Complete the subtree rooted at the selected node',
  );

  const constraintSubtitle = document.querySelector(
    `#${CONSTRAINT_MODAL_ID} .constraint-header-copy span`,
  );
  setText(
    constraintSubtitle,
    'Optimally complete the subtree rooted at the selected node subject to constraints and the current Rashomon budget.',
  );
}

const observer = new MutationObserver(updateCompletionScopeCopy);
observer.observe(document.body, { childList: true, subtree: true });
updateCompletionScopeCopy();
