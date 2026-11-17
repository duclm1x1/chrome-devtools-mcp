/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createZip} from '../../src/utils/zip.js';

const decoder = new TextDecoder();

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function entryData(zip: Uint8Array, index: number): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let offset = 0;
  for (let i = 0; i < index; i++) {
    const nameLength = readU16(view, offset + 26);
    const extraLength = readU16(view, offset + 28);
    const size = readU32(view, offset + 18);
    offset += 30 + nameLength + extraLength + size;
  }
  const nameLength = readU16(view, offset + 26);
  const extraLength = readU16(view, offset + 28);
  const size = readU32(view, offset + 18);
  const start = offset + 30 + nameLength + extraLength;
  return zip.slice(start, start + size);
}

describe('createZip', () => {
  it('writes store-method entries and a central directory', () => {
    const zip = createZip([
      {path: 'a/hello.txt', data: new TextEncoder().encode('hello')},
      {path: 'b/c.json', data: new TextEncoder().encode('{"ok":true}')},
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    assert.equal(readU32(view, 0), 0x04034b50);
    assert.equal(decoder.decode(entryData(zip, 0)), 'hello');
    assert.equal(decoder.decode(entryData(zip, 1)), '{"ok":true}');

    const eocd = zip.length - 22;
    assert.equal(readU32(view, eocd), 0x06054b50);
    assert.equal(readU16(view, eocd + 10), 2);
    const centralOffset = readU32(view, eocd + 16);
    assert.equal(readU32(view, centralOffset), 0x02014b50);
  });

  it('handles an empty archive', () => {
    const zip = createZip([]);
    assert.equal(zip.length, 22);
    const view = new DataView(zip.buffer);
    assert.equal(readU32(view, 0), 0x06054b50);
    assert.equal(readU16(view, 10), 0);
  });

  it('renames duplicate paths and drops empty segments', () => {
    const zip = createZip([
      {path: '../a.txt', data: new TextEncoder().encode('one')},
      {path: '../a.txt', data: new TextEncoder().encode('two')},
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    assert.equal(readU16(view, eocd + 10), 2);
    assert.equal(decoder.decode(entryData(zip, 0)), 'one');
    assert.equal(decoder.decode(entryData(zip, 1)), 'two');
    assert.equal(readU32(view, 0), 0x04034b50);
  });
});
