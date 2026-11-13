const assert = require('node:assert/strict');
async function exerciseDefaultAnalysis(page) {
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Analyze partial tree' });
  await dialog.getByRole('heading', { name: 'Feature importance ranges' }).waitFor();
  await dialog.getByText('Dataset attached · 17,379 samples').waitFor();
  assert.ok(Number(await dialog.locator('.analysis-metrics b').first().textContent()) > 0);
  assert.equal(await dialog.locator('.analysis-importance tbody tr').count(), 12);
  await dialog.getByRole('heading', { name: 'Prediction disagreement across samples' }).waitFor();
  await dialog.getByRole('button', { name: 'Close analysis' }).click();
}
async function exerciseImportedAnalysis(page) {
  const payload = { graph: { root_trie_id: 7,
    trie_nodes: [{ id: 7, budget: 10, subproblem_size: 4, min_objective: 2, leaf_ids: [4, 5, 6], split_ids: [] }], split_nodes: [],
    leaf_nodes: [0, 1, -1].map((prediction, i) => ({ id: 4 + i, parent_trie_id: 7, prediction, loss: prediction === -1 ? 2 : 3, subproblem_size: 4 })) },
    meta: { root_n: 4, gamma: 1, lambda_reg: .25, eta_defer: .25, use_deferral: true, classNames: ['no', 'yes'], featureRegistry: [] } };
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Upload graph' }).click();
  await page.getByLabel('Upload graph JSON').setInputFiles({ name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await page.waitForFunction(() => window.ARBORENUM_CURRENT_BUILDER_PAYLOAD?.graph?.root_trie_id === 7);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Analyze partial tree' });
  await dialog.getByText('Feasible completions', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.analysis-metrics b').first().textContent(), '3');
  await dialog.getByText(/Permutation importance and sample disagreement require/).waitFor();
  await dialog.getByLabel('Analysis dataset CSV').setInputFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('constant,label\n0,no\n0,yes\n0,no\n0,yes\n') });
  await dialog.getByLabel('Classification target').selectOption('label');
  await dialog.getByRole('button', { name: 'Use dataset and analyze' }).click();
  await dialog.getByRole('heading', { name: 'Feature importance ranges' }).waitFor();
  await dialog.getByRole('heading', { name: 'Prediction disagreement across samples' }).waitFor();
  assert.equal(await dialog.locator('.analysis-metrics b').first().textContent(), '3');
  assert.match(await dialog.locator('.analysis-metrics b').nth(1).textContent(), /50%/);
  await dialog.getByRole('button', { name: 'Close analysis' }).click();
}
module.exports = { exerciseImportedAnalysis, exerciseDefaultAnalysis };
