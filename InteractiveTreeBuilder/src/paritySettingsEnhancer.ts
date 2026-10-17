function normalizeSettingsPopover() {
  const popover = document.querySelector<HTMLElement>('.settings-popover');
  if (!popover) return;

  const binarySection = Array.from(popover.querySelectorAll<HTMLElement>('.settings-section')).find(
    (section) =>
      section.querySelector<HTMLElement>('.settings-section-title')?.textContent?.trim() ===
      'Binary feature names',
  );

  if (binarySection && !binarySection.querySelector('.binary-parity-heading')) {
    const firstRow = binarySection.querySelector<HTMLElement>('.settings-row');
    if (firstRow) {
      const heading = document.createElement('div');
      heading.className = 'binary-parity-heading';
      heading.innerHTML = '<span>Parity</span>';
      binarySection.insertBefore(heading, firstRow);
    }
  }

  const actions = popover.querySelector<HTMLElement>('.settings-actions');
  if (!actions) return;

  const buttons = Array.from(actions.querySelectorAll<HTMLButtonElement>('button'));
  const byText = new Map(buttons.map((button) => [button.textContent?.trim(), button]));

  for (const label of ['Reset names', 'Reset colors', 'Reset parity']) {
    const button = byText.get(label);
    if (button) actions.appendChild(button);
  }
}

let scheduled = false;
function scheduleNormalize() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    normalizeSettingsPopover();
  });
}

const style = document.createElement('style');
style.textContent = `
  .binary-parity-heading {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr) 46px;
    gap: 10px;
    align-items: center;
    margin: -2px 0 5px;
    color: #64748b;
    font-size: 10px;
    font-weight: 850;
    letter-spacing: .08em;
    text-transform: uppercase;
  }

  .binary-parity-heading span {
    grid-column: 3;
    justify-self: center;
    white-space: nowrap;
  }
`;
document.head.appendChild(style);

scheduleNormalize();
new MutationObserver(scheduleNormalize).observe(document.body, {
  subtree: true,
  childList: true,
});
