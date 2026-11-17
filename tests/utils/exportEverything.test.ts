/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  assetPathFor,
  categoryForAsset,
  cookieMatchesHost,
  cookiesToNetscape,
  type SimpleCookie,
} from '../../src/utils/exportEverything.js';

const cookies: SimpleCookie[] = [
  {
    domain: '.example.com',
    expirationDate: 1900000000,
    hostOnly: false,
    httpOnly: true,
    name: 'session',
    path: '/',
    sameSite: 'lax',
    secure: true,
    session: false,
    storeId: '0',
    value: 'abc',
  },
  {
    domain: 'www.example.com',
    hostOnly: true,
    httpOnly: false,
    name: 'locale',
    path: '/',
    sameSite: 'unspecified',
    secure: false,
    session: true,
    storeId: '0',
    value: 'en_US',
  },
];

describe('cookie helpers', () => {
  it('matches parent domains without suffix confusion', () => {
    assert.equal(cookieMatchesHost('.example.com', 'www.example.com'), true);
    assert.equal(cookieMatchesHost('.example.com', 'example.com'), true);
    assert.equal(cookieMatchesHost('.example.com', 'notexample.com'), false);
  });

  it('writes Netscape cookies.txt with HttpOnly prefixes', () => {
    const text = cookiesToNetscape(cookies);
    const rows = text
      .trim()
      .split('\n')
      .filter(
        line =>
          line.trim() &&
          (!line.startsWith('#') || line.startsWith('#HttpOnly_')),
      );
    assert.equal(rows.length, 2);
    assert.equal(
      rows[0],
      '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1900000000\tsession\tabc',
    );
    assert.equal(rows[1], 'www.example.com\tFALSE\t/\tFALSE\t0\tlocale\ten_US');
  });
});

describe('asset helpers', () => {
  it('categories by MIME and ignores textual 404 bodies', () => {
    assert.equal(
      categoryForAsset('image/png', 'https://x.test/a.png'),
      'images',
    );
    assert.equal(categoryForAsset('text/plain', 'https://x.test/a.png'), '');
    assert.equal(
      categoryForAsset('application/octet-stream', 'https://x.test/a.woff2'),
      'fonts',
    );
  });

  it('builds stable, unique-friendly asset paths', () => {
    const path = assetPathFor(
      'https://cdn.test/img/logo.png?v=2',
      'image/png',
      3,
    );
    assert.match(
      path,
      /^assets\/images\/cdn\.test\/0003-[0-9a-f]{8}-logo\.png$/,
    );
    assert.equal(
      path,
      assetPathFor('https://cdn.test/img/logo.png?v=2', 'image/png', 3),
    );
  });
});
