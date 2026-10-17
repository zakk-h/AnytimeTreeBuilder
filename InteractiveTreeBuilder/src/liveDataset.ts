type Dataset = { feature_names: string[]; class_names: string[]; X: number[][]; y: number[] };

// RFC 4180 fields, including quoted commas/newlines and escaped quotes. Empty
// numeric cells are rejected rather than silently becoming zero.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; ++i) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; ++i; }
      else if (ch === '"') { quoted = false; closed = true; }
      else cell += ch;
    } else if (ch === '"') {
      if (cell || closed) throw new Error('Unexpected quote in CSV.');
      quoted = true;
    } else if (ch === ',') { row.push(cell); cell = ''; closed = false; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') ++i;
      row.push(cell); if (row.some(value => value.trim())) rows.push(row);
      row = []; cell = ''; closed = false;
    } else {
      if (closed && ch.trim()) throw new Error('Unexpected text after a quoted CSV field.');
      if (!closed) cell += ch;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2 || rows[0].length < 2) throw new Error('CSV needs a header, at least one feature and a target column.');
  if (rows.some(row => row.length !== rows[0].length)) throw new Error('CSV rows have different numbers of columns.');
  rows[0] = rows[0].map(value => value.trim());
  if (new Set(rows[0]).size !== rows[0].length || rows[0].some(value => !value)) throw new Error('CSV headers must be unique and nonempty.');
  return rows;
}
export function toDataset(rows: string[][], target: string): Dataset {
  const targetIndex = rows[0].indexOf(target);
  if (targetIndex < 0) throw new Error('Select a target column.');
  const features = rows[0].map((_, i) => i).filter(i => i !== targetIndex);
  const classes = new Map<string, number>();
  const X: number[][] = [], y: number[] = [];
  rows.slice(1).forEach((row, index) => {
    const label = row[targetIndex].trim();
    if (!label) throw new Error(`Missing target at row ${index + 2}.`);
    if (!classes.has(label)) classes.set(label, classes.size);
    y.push(classes.get(label)!);
    X.push(features.map(f => {
      const value = row[f].trim();
      if (!value || !Number.isFinite(Number(value))) throw new Error(`Row ${index + 2}, ${rows[0][f]} must be a finite number.`);
      return Number(value);
    }));
  });
  return { feature_names: features.map(f => rows[0][f]), class_names: [...classes.keys()], X, y };
}
