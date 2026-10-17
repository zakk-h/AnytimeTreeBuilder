type Dataset = { feature_names: string[]; class_names: string[]; X: number[][]; y: number[] };

// RFC 4180 fields, including quoted commas/newlines and escaped quotes. Empty
// cells are rejected rather than silently becoming zero.
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
// Text categories are represented as named 0/1 indicators, avoiding an
// arbitrary numeric ordering between values such as "red", "green", and "blue".
export function toDataset(rows: string[][], target: string): Dataset {
  const targetIndex = rows[0].indexOf(target);
  if (targetIndex < 0) throw new Error('Select a target column.');
  const features = rows[0].map((_, i) => i).filter(i => i !== targetIndex);
  const classes = new Map<string, number>();
  const data = rows.slice(1);
  const X: number[][] = data.map(() => []), y: number[] = [];
  const feature_names: string[] = [];
  const usedNames = new Set(features.map(f => rows[0][f]));
  data.forEach((row, index) => {
    const label = row[targetIndex].trim();
    if (!label) throw new Error(`Missing target at row ${index + 2}.`);
    if (!classes.has(label)) classes.set(label, classes.size);
    y.push(classes.get(label)!);
  });
  for (const f of features) {
    const values = data.map((row, index) => {
      const value = row[f].trim();
      if (!value) throw new Error(`Row ${index + 2}, ${rows[0][f]} is missing.`);
      return value;
    });
    const numbers = values.map((value, index) => {
      if (/^true$/i.test(value)) return 1;
      if (/^false$/i.test(value)) return 0;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return undefined;
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`Row ${index + 2}, ${rows[0][f]} must be a finite number.`);
      return number;
    });
    if (numbers.every(value => value !== undefined)) {
      feature_names.push(rows[0][f]);
      numbers.forEach((value, index) => X[index].push(value));
    } else {
      const categories = [...new Set(values)].sort();
      for (const category of categories) {
        const base = `${rows[0][f]} = ${JSON.stringify(category)}`;
        let name = base, suffix = 2;
        while (usedNames.has(name)) name = `${base} [${suffix++}]`;
        usedNames.add(name);
        feature_names.push(name);
      }
      const indices = new Map(categories.map((value, index) => [value, index]));
      values.forEach((value, index) => {
        const category = indices.get(value)!;
        for (let c = 0; c < categories.length; ++c) X[index].push(c === category ? 1 : 0);
      });
    }
  }
  return { feature_names, class_names: [...classes.keys()], X, y };
}
