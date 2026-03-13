export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let insideQuote = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (insideQuote) {
      if (char === '"' && next === '"') {
        currentCell += '"';
        i += 1;
      } else if (char === '"') {
        insideQuote = false;
      } else {
        currentCell += char;
      }
      continue;
    }

    if (char === '"') {
      insideQuote = true;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
      continue;
    }

    if (char !== '\r') {
      currentCell += char;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows.filter((row) => row.some((cell) => cell.length > 0));
}

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}
