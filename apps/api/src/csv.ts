import { Readable } from 'node:stream';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ParsedRecipient = { email: string; row: number; values: Record<string, string> };
export type CsvSummary = { total: number; valid: number; invalid: number; duplicates: number; recipients: ParsedRecipient[] };

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  out.push(current.trim());
  return out;
}

export async function parseRecipientsCsv(input: AsyncIterable<string> | Readable, emailColumn = 'email'): Promise<CsvSummary> {
  let header: string[] | null = null;
  let row = 0;
  let total = 0;
  let valid = 0;
  let invalid = 0;
  let duplicates = 0;
  const seen = new Set<string>();
  const recipients: ParsedRecipient[] = [];

  const lines = input as AsyncIterable<string>;
  for await (const raw of lines) {
    const line = String(raw).replace(/\r$/, '');
    if (!line.trim()) continue;
    row += 1;
    const values = splitCsvLine(line);
    if (!header) {
      header = values.map((v) => v.toLowerCase());
      if (!header.includes(emailColumn.toLowerCase())) throw new Error(`CSV missing required column: ${emailColumn}`);
      continue;
    }
    total += 1;
    const record: Record<string, string> = {};
    header.forEach((key, index) => { record[key] = values[index] ?? ''; });
    const email = (record[emailColumn.toLowerCase()] ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { invalid += 1; continue; }
    if (seen.has(email)) { duplicates += 1; continue; }
    seen.add(email);
    valid += 1;
    recipients.push({ email, row, values: record });
  }
  if (!header) throw new Error('CSV is empty');
  return { total, valid, invalid, duplicates, recipients };
}

export async function readCsvText(text: string, maxBytes = 10 * 1024 * 1024): Promise<CsvSummary> {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`CSV exceeds ${maxBytes} byte limit`);
  return parseRecipientsCsv(text.split(/\n/));
}
