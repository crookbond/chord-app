import { describe, expect, it } from 'vitest';

import { parseJsonArray, parseJsonLoose, parseJsonObject } from '../json-repair.js';

describe('parseJsonLoose', () => {
  it('parses a clean JSON object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown ```json fences', () => {
    const raw = '```json\n{"calls":[{"name":"create_task"}]}\n```';
    expect(parseJsonLoose(raw)).toEqual({ calls: [{ name: 'create_task' }] });
  });

  it('strips unlabelled ``` fences', () => {
    expect(parseJsonLoose('```\n{"x":true}\n```')).toEqual({ x: true });
  });

  it('ignores preamble before the JSON', () => {
    expect(parseJsonLoose('Sure, here you go: {"ok":true}')).toEqual({ ok: true });
  });

  it('fixes trailing commas before } or ]', () => {
    expect(parseJsonLoose('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  it('closes truncated output', () => {
    expect(parseJsonLoose('{"a":1,"b":[1,2')).toEqual({ a: 1, b: [1, 2] });
  });

  it('stops at the first balanced structure', () => {
    expect(parseJsonLoose('{"a":1} garbage {"b":2}')).toEqual({ a: 1 });
  });

  it('returns null when nothing resembles JSON', () => {
    expect(parseJsonLoose('no data here')).toBeNull();
  });
});

describe('parseJsonObject', () => {
  it('parses a clean object', () => {
    expect(parseJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('strips ```json fences', () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips unlabelled ``` fences', () => {
    expect(parseJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('grabs the outer object when surrounded by prose', () => {
    expect(parseJsonObject('Here is the data: {"a":1} thanks!')).toEqual({ a: 1 });
  });

  it('returns null on a top-level array (use parseJsonArray for that)', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull();
  });

  it('returns null on bare text', () => {
    expect(parseJsonObject('not json at all')).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    expect(parseJsonObject('{"a":')).toBeNull();
  });

  it('returns null on null literal (must be a real object)', () => {
    expect(parseJsonObject('null')).toBeNull();
  });
});

describe('parseJsonArray', () => {
  it('parses a clean array', () => {
    expect(parseJsonArray('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    expect(parseJsonArray('```json\n[{"k":"v"}]\n```')).toEqual([{ k: 'v' }]);
  });

  it('falls back to regex extraction when prose surrounds the array', () => {
    expect(parseJsonArray('Sure! [1,2] there you go')).toEqual([1, 2]);
  });

  it('returns null on a top-level object (use parseJsonObject for that)', () => {
    expect(parseJsonArray('{"a":1}')).toBeNull();
  });

  it('returns null on bare text', () => {
    expect(parseJsonArray('nothing here')).toBeNull();
  });

  it('returns null on malformed array contents', () => {
    expect(parseJsonArray('[1, 2,')).toBeNull();
  });

  it('handles nested arrays', () => {
    expect(parseJsonArray('[[1,2],[3,4]]')).toEqual([[1, 2], [3, 4]]);
  });
});
