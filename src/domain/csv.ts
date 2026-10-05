/**
 * RFC 4180 CSV parser. Hand-written because the Worker has a 10 ms CPU budget
 * and the LCSC exports need exactly four things: quoted fields, commas inside
 * quotes ("PMEG4030EP,115"), doubled quotes, and newlines inside quotes.
 *
 * Returns rows of raw strings. A trailing blank line yields no row. A BOM is
 * stripped. An unterminated quote is an error, not silently-truncated data.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // A row that is one empty field is a blank line.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else if (c === '\n') {
      endRow();
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError('Unterminated quoted field: the file looks truncated or corrupt.');
  if (fieldStarted || field !== '' || row.length > 0) endRow();
  return rows;
}

export class CsvError extends Error {}
