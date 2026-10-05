import { describe, expect, it } from 'vitest';
import { parseCsv, CsvError } from '../src/domain/csv';
import { costIdrMicro, parseMicro, MoneyError } from '../src/domain/money';
import { guessCategory, guessValue, normalizeManufacturer } from '../src/domain/normalize';
import { orderDateFromOrderNo, parseLcscCsv, parseLcscFilename, planLcscImport } from '../src/domain/lcsc';

describe('parseCsv', () => {
  it('keeps a comma inside quotes in one field', () => {
    expect(parseCsv('a,"PMEG4030EP,115",c\n')).toEqual([['a', 'PMEG4030EP,115', 'c']]);
  });
  it('unescapes doubled quotes and keeps newlines inside quotes', () => {
    expect(parseCsv('"he said ""hi""\nthere",x')).toEqual([['he said "hi"\nthere', 'x']]);
  });
  it('handles CRLF, a BOM and a missing final newline', () => {
    expect(parseCsv('﻿a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c,\n')).toEqual([['a', '', 'c', '']]);
  });
  it('skips blank lines', () => {
    expect(parseCsv('a\n\nb\n\n')).toEqual([['a'], ['b']]);
  });
  it('refuses an unterminated quote instead of truncating', () => {
    expect(() => parseCsv('a,"b')).toThrow(CsvError);
  });
});

describe('money', () => {
  it('parses decimals to micro-units without floats', () => {
    expect(parseMicro('0.0046')).toBe(4600);
    expect(parseMicro('3.8691')).toBe(3_869_100);
    expect(parseMicro('2')).toBe(2_000_000);
    expect(() => parseMicro('1.2345678')).toThrow(MoneyError);
    expect(() => parseMicro('-1')).toThrow(MoneyError);
  });
  it('converts at a frozen FX rate with BigInt, past 2^53', () => {
    // 0.0002 USD at 16,500 IDR/USD is 3.3 IDR = 3_300_000 micro-IDR.
    expect(costIdrMicro(200, 16_500_000_000)).toBe(3_300_000);
    expect(costIdrMicro(3_869_100, 16_500_000_000)).toBe(63_840_150_000);
  });
});

describe('normalize', () => {
  it('maps both spellings of Diodes to one manufacturer', () => {
    expect(normalizeManufacturer('DIODES')).toBe(normalizeManufacturer('Diodes Incorporated'));
  });
  it('does not merge different makers', () => {
    expect(normalizeManufacturer('Texas Instruments')).not.toBe(normalizeManufacturer('TDSEMIC'));
  });
  it('guesses categories and values from LCSC descriptions', () => {
    expect(guessCategory('2.8V~5.5V 1-Channel Class D QFN-9 Audio Amplifiers RoHS')).toBe('IC - Audio');
    expect(guessCategory('Standard (General Purpose) Amplifier 2 Circuit SOP-8')).toBe('IC - Op Amp');
    expect(guessCategory('N-Channel 30V 50A Surface Mount DFN-8(3x3)')).toBe('Discrete - MOSFET');
    expect(guessCategory('-')).toBe('Other');
    expect(guessValue('250mW 33kΩ 150V Thick Film Resistor', 'Passive - Resistor')).toBe('33kΩ');
    expect(guessValue('2.4A 10uH ±20% Molded inductor', 'Passive - Inductor')).toBe('10uH');
  });
});

import csv1 from './fixtures/lcsc/LCSC__WM2509100613_20261006045136.csv?raw';
import csv2 from './fixtures/lcsc/LCSC__WM2408250114_20261006045133.csv?raw';
const F1 = 'LCSC__WM2509100613_20261006045136.csv';
const F2 = 'LCSC__WM2408250114_20261006045133.csv';
const fixture = (n: string) => (n === F1 ? csv1 : csv2);

describe('LCSC export', () => {
  it('reads the order number and date from the filename', () => {
    expect(parseLcscFilename(`/x/${F1}`)?.orderNo).toBe('WM2509100613');
    expect(parseLcscFilename('other.csv')).toBeNull();
    expect(orderDateFromOrderNo('WM2509100613')).toBe('2025-09-10');
    expect(orderDateFromOrderNo('WM2408250114')).toBe('2024-08-25');
  });
  it('parses both real exports with no errors and the expected line counts', () => {
    const a = parseLcscCsv(fixture(F1));
    const b = parseLcscCsv(fixture(F2));
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    expect(a.lines).toHaveLength(59);
    expect(b.lines).toHaveLength(41);
    expect(a.lines.find((l) => l.lcsc === 'C96234')?.mpn).toBe('PMEG4030EP,115');
  });
  it('rejects a file that is not an LCSC export', () => {
    expect(parseLcscCsv('a,b\n1,2').errors[0]).toMatch(/does not look like an LCSC/);
  });
  it('reports a bad row by number instead of dropping it', () => {
    const csv = fixture(F2).replace(',8,0.8226,', ',eight,0.8226,');
    expect(parseLcscCsv(csv).errors[0]).toMatch(/^Row 1: quantity/);
  });
  it('plans 99 new parts from the two exports, merging PAM8013AKR and flagging the "-" part', () => {
    const l1 = parseLcscCsv(fixture(F1)).lines;
    const l2 = parseLcscCsv(fixture(F2)).lines;
    const p1 = planLcscImport({ lines: l1, existingParts: [], existingOrderPartIds: new Set() });
    expect(p1.errors).toEqual([]);
    expect(p1.summary.newParts).toBe(59);
    const review = p1.lines.filter((l) => l.needsReview).map((l) => l.line.mpn);
    expect(review).toEqual(['V106M0603X5R250NKT']);
    // Second order sees PAM8013AKR already exists, matched by C-number.
    const existing = p1.lines.map((l, i) => ({
      id: i + 1, mpn: l.line.mpn, manufacturer: l.line.manufacturer,
      manufacturerNorm: l.manufacturerNorm, lcscCode: l.line.lcsc,
    }));
    const p2 = planLcscImport({ lines: l2, existingParts: existing, existingOrderPartIds: new Set() });
    expect(p2.errors).toEqual([]);
    expect(p2.summary.newParts).toBe(40);
    expect(p2.summary.matchedParts).toBe(1);
    const pam = p2.lines.find((l) => l.line.mpn === 'PAM8013AKR')!;
    expect(pam.matchedBy).toBe('lcsc');
    expect(pam.manufacturerVariant).toBe(true);
  });
  it('matches by MPN + manufacturer when the C-number is unknown, and offers to set it', () => {
    const l = parseLcscCsv(fixture(F2)).lines.filter((x) => x.lcsc === 'C444418');
    const plan = planLcscImport({
      lines: l,
      existingParts: [{ id: 9, mpn: 'pam8013akr', manufacturer: 'DIODES', manufacturerNorm: 'diodes', lcscCode: null }],
      existingOrderPartIds: new Set(),
    });
    expect(plan.lines[0]).toMatchObject({ action: 'match_part', matchedBy: 'mpn', setLcscCode: true, partId: 9 });
  });
  it('marks lines already on the order as duplicates, so a re-import changes nothing', () => {
    const lines = parseLcscCsv(fixture(F2)).lines;
    const first = planLcscImport({ lines, existingParts: [], existingOrderPartIds: new Set() });
    const existing = first.lines.map((l, i) => ({
      id: i + 1, mpn: l.line.mpn, manufacturer: l.line.manufacturer,
      manufacturerNorm: l.manufacturerNorm, lcscCode: l.line.lcsc,
    }));
    const again = planLcscImport({
      lines, existingParts: existing, existingOrderPartIds: new Set(existing.map((e) => e.id)),
    });
    expect(again.summary).toMatchObject({ duplicates: 41, newParts: 0, lotsToCreate: 0, piecesToReceive: 0 });
  });
  it('refuses a file that lists the same part twice', () => {
    const lines = parseLcscCsv(fixture(F2)).lines.slice(0, 2);
    lines.push({ ...lines[0]!, row: 3 });
    const plan = planLcscImport({ lines, existingParts: [], existingOrderPartIds: new Set() });
    expect(plan.errors[0]).toMatch(/Row 3 repeats the part from row 1/);
  });
});
