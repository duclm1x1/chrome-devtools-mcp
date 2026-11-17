/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';

import type {ContextPage} from '../tools/ToolDefinition.js';
import {ConsoleMessage, type Page} from '../third_party/index.js';

import {createZip, type ZipEntry} from './zip.js';

type NetworkRequest = ReturnType<ContextPage['getNetworkRequests']>[number];
type ConsoleItem = ReturnType<ContextPage['getConsoleData']>[number];
type BrowserCookie = Awaited<ReturnType<Page['cookies']>>[number];
type CdpSession = Awaited<ReturnType<Page['createCDPSession']>>;

export interface ExportEverythingOptions {
  includeAllCookies: boolean;
  includeBodies: boolean;
  includeStorage: boolean;
  includeScreenshots: boolean;
  includeAssets: boolean;
  maxAssetBytes: number;
  maxTotalBodyBytes: number;
}

export interface ExportEverythingResult {
  zip: Uint8Array;
  manifest: ExportManifest;
}

export interface ExportManifest {
  tool: string;
  version: string;
  exportedAt: string;
  page: {url: string; title: string};
  options: ExportEverythingOptions;
  counts: {
    harEntries: number;
    cookies: number;
    consoleEntries: number;
    assets: number;
    files: number;
    bytes: number;
  };
  warnings: string[];
  files: Array<{path: string; size: number}>;
}

export interface SimpleCookie {
  domain: string;
  expirationDate?: number;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: string;
  secure: boolean;
  session: boolean;
  storeId: string;
  value: string;
  partitionKey?: unknown;
}

interface HarHeader {
  name: string;
  value: string;
}

interface HarContent {
  size: number;
  mimeType: string;
  text: string;
  encoding: 'base64';
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarHeader[];
  queryString: Array<{name: string; value: string}>;
  cookies: Array<{name: string; value: string}>;
  headersSize: number;
  bodySize: number;
  postData?: {mimeType: string; text: string};
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: HarHeader[];
  cookies: Array<{name: string; value: string}>;
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, never>;
  timings: {send: number; wait: number; receive: number};
  _resourceType: string;
  _fromCache?: boolean;
  _fromServiceWorker?: boolean;
}

interface HarLog {
  version: '1.2';
  creator: {name: string; version: string};
  pages: never[];
  entries: HarEntry[];
}

interface ConsoleRecord {
  level: string;
  text: string;
  stack?: string;
  url: string;
  timestamp: number;
}

const EMPTY_CONTENT: HarContent = {
  size: 0,
  mimeType: '',
  text: '',
  encoding: 'base64',
};

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

function headersToHar(headers: Record<string, string>): HarHeader[] {
  const result: HarHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    result.push({name, value});
  }
  return result;
}

function mimeTypeFromHeaders(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') {
      return value.split(';')[0]?.trim() ?? '';
    }
  }
  return '';
}

function requestTime(request: NetworkRequest): number {
  const response = request.response();
  if (!response) {
    return 0;
  }
  const timing = response.timing();
  if (!timing) {
    return 0;
  }
  return Math.max(
    0,
    (timing.sendStart ?? 0) +
      (timing.sendEnd ?? 0) +
      (timing.receiveHeadersEnd ?? 0),
  );
}

function extensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split('/').pop() ?? '';
    const match = last.match(/\.([a-z0-9]{1,8})$/i);
    return match?.[1]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

function extensionFromMime(mime: string): string {
  return MIME_EXTENSIONS[mime.split(';')[0]?.trim().toLowerCase() ?? ''] ?? '';
}

export function categoryForAsset(mime: string, url: string): string {
  const clean = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (clean.startsWith('image/')) {
    return 'images';
  }
  if (clean.startsWith('font/') || /font-(woff|ttf|otf)/.test(clean)) {
    return 'fonts';
  }
  if (clean.startsWith('audio/') || clean.startsWith('video/')) {
    return 'media';
  }
  if (clean === 'application/pdf') {
    return 'documents';
  }
  if (clean) {
    if (/^(text\/|application\/(json|javascript|xml|xhtml\+xml))/.test(clean)) {
      return '';
    }
  }
  const extension = extensionFromUrl(url);
  if (
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'].includes(
      extension,
    )
  ) {
    return 'images';
  }
  if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) {
    return 'fonts';
  }
  if (
    ['mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'ogv', 'mov'].includes(
      extension,
    )
  ) {
    return 'media';
  }
  if (['pdf'].includes(extension)) {
    return 'documents';
  }
  return '';
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function slug(value: string, maxLength = 80): string {
  let result = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (result.length > maxLength) {
    const dot = result.lastIndexOf('.');
    const extension =
      dot > 0 && result.length - dot <= 10 ? result.slice(dot) : '';
    result = result.slice(0, maxLength - extension.length) + extension;
  }
  return result || 'file';
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return slug(parsed.hostname || 'unknown', 60);
  } catch {
    return 'unknown';
  }
}

export function assetPathFor(url: string, mime: string, index: number): string {
  const category = categoryForAsset(mime, url) || 'other';
  const extension = extensionFromMime(mime) || extensionFromUrl(url) || 'bin';
  let base = 'file';
  try {
    const parsed = new URL(url);
    base =
      decodeURIComponent(
        parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname,
      ) || 'file';
  } catch {
    base = 'file';
  }
  base = slug(base, 70);
  if (!base.toLowerCase().endsWith(`.${extension}`)) {
    base = `${base}.${extension}`;
  }
  return `assets/${category}/${hostOf(url)}/${String(index).padStart(4, '0')}-${fnv1a(url)}-${base}`;
}

export function cookieMatchesHost(domain: string, host: string): boolean {
  const cleanDomain = domain.replace(/^\./, '').toLowerCase();
  const cleanHost = host.toLowerCase();
  if (!cleanDomain || !cleanHost) {
    return false;
  }
  return cleanHost === cleanDomain || cleanHost.endsWith(`.${cleanDomain}`);
}

function sameSiteForNetscape(value: string): string {
  switch (value.toLowerCase()) {
    case 'no_restriction':
    case 'none':
      return 'no_restriction';
    case 'lax':
      return 'lax';
    case 'strict':
      return 'strict';
    default:
      return 'unspecified';
  }
}

export function cookiesToNetscape(cookies: SimpleCookie[]): string {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Generated by chrome-devtools-mcp export_everything.',
    '# domain\tincludeSubdomains\tpath\tsecure\texpiry\tname\tvalue',
    '',
  ];
  for (const cookie of cookies) {
    if (!cookie.domain) {
      continue;
    }
    const domain = cookie.domain.replace(/[\t\r\n]/g, ' ');
    const hostOnly = !domain.startsWith('.');
    const expires = Number(cookie.expirationDate);
    const expiry =
      Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 0;
    lines.push(
      [
        `${cookie.httpOnly ? '#HttpOnly_' : ''}${domain}`,
        hostOnly ? 'FALSE' : 'TRUE',
        (cookie.path || '/').replace(/[\t\r\n]/g, ' '),
        cookie.secure ? 'TRUE' : 'FALSE',
        String(expiry),
        cookie.name.replace(/[\t\r\n]/g, ' '),
        cookie.value.replace(/[\t\r\n]/g, ' '),
      ].join('\t'),
    );
  }
  lines.push('');
  return lines.join('\n');
}

function toSimpleCookie(cookie: BrowserCookie): SimpleCookie {
  return {
    domain: cookie.domain,
    expirationDate:
      cookie.expires && cookie.expires > 0 ? cookie.expires : undefined,
    hostOnly: !cookie.domain.startsWith('.'),
    httpOnly: Boolean(cookie.httpOnly),
    name: cookie.name,
    path: cookie.path,
    sameSite: sameSiteForNetscape(cookie.sameSite ?? 'unspecified'),
    secure: Boolean(cookie.secure),
    session: !cookie.expires || cookie.expires <= 0,
    storeId: '0',
    value: cookie.value,
  };
}

async function collectCookies(
  page: Page,
  session: CdpSession,
  includeAllCookies: boolean,
  pageUrl: string,
  warnings: string[],
): Promise<SimpleCookie[]> {
  let cookies: SimpleCookie[] = [];
  try {
    const response = await session.send('Network.getAllCookies');
    for (const cookie of response.cookies) {
      cookies.push({
        domain: cookie.domain,
        expirationDate:
          cookie.expires && cookie.expires > 0 ? cookie.expires : undefined,
        hostOnly: !cookie.domain.startsWith('.'),
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: sameSiteForNetscape(cookie.sameSite ?? 'unspecified'),
        secure: cookie.secure,
        session: cookie.session,
        storeId: '0',
        value: cookie.value,
        partitionKey: cookie.partitionKey,
      });
    }
  } catch (error) {
    warnings.push(
      `Network.getAllCookies failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!cookies.length) {
    try {
      const fallback = await page.cookies();
      cookies = fallback.map(cookie => toSimpleCookie(cookie));
    } catch (error) {
      warnings.push(
        `page.cookies failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (!includeAllCookies && cookies.length) {
    let host = '';
    try {
      host = new URL(pageUrl).hostname;
    } catch {
      host = '';
    }
    if (host) {
      cookies = cookies.filter(candidate =>
        cookieMatchesHost(candidate.domain, host),
      );
    }
  }

  return cookies.sort((a, b) =>
    `${a.domain}\u0000${a.path}\u0000${a.name}`.localeCompare(
      `${b.domain}\u0000${b.path}\u0000${b.name}`,
    ),
  );
}

async function buildHar(
  requests: NetworkRequest[],
  options: ExportEverythingOptions,
  files: ZipEntry[],
  usedPaths: Set<string>,
  warnings: string[],
): Promise<{log: HarLog; bodyBytes: number; assetCount: number}> {
  const entries: HarEntry[] = [];
  let bodyBytes = 0;
  let assetCount = 0;
  const assetUrls = new Set<string>();

  for (const request of requests) {
    const response = request.response();
    const requestHeaders = request.headers();
    const responseHeaders = response?.headers() ?? {};
    const mimeType =
      response?.headers()['content-type'] ??
      mimeTypeFromHeaders(responseHeaders);
    let body: Uint8Array = new Uint8Array(0);

    if (options.includeBodies && response) {
      if (bodyBytes >= options.maxTotalBodyBytes) {
        warnings.push(
          `HAR body budget reached (${options.maxTotalBodyBytes} bytes); later responses were not included`,
        );
      } else {
        try {
          const buffer = await response.buffer();
          if (buffer.length <= options.maxTotalBodyBytes - bodyBytes) {
            body = buffer;
            bodyBytes += buffer.length;
          } else {
            warnings.push(
              `response body skipped (budget): ${request.url()} (${buffer.length} bytes)`,
            );
          }
        } catch (error) {
          warnings.push(
            `response body unavailable: ${request.url()} (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
    }

    const postData = request.postData();
    const harRequest: HarRequest = {
      method: request.method(),
      url: request.url(),
      httpVersion: 'HTTP/1.1',
      headers: headersToHar(requestHeaders),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: postData ? Buffer.byteLength(postData) : 0,
    };
    if (postData) {
      harRequest.postData = {
        mimeType: requestHeaders['content-type'] ?? 'application/octet-stream',
        text: postData,
      };
    }

    const harResponse: HarResponse = {
      status: response?.status() ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: headersToHar(responseHeaders),
      cookies: [],
      content:
        body.length > 0
          ? {
              size: body.length,
              mimeType,
              text: Buffer.from(body).toString('base64'),
              encoding: 'base64',
            }
          : {...EMPTY_CONTENT, mimeType},
      redirectURL: response?.headers()['location'] ?? '',
      headersSize: -1,
      bodySize: body.length,
    };

    const entry: HarEntry = {
      startedDateTime: new Date().toISOString(),
      time: requestTime(request),
      request: harRequest,
      response: harResponse,
      cache: {},
      timings: {send: 0, wait: 0, receive: 0},
      _resourceType: request.resourceType(),
    };
    if (response?.fromCache()) {
      entry._fromCache = true;
    }
    if (response?.fromServiceWorker()) {
      entry._fromServiceWorker = true;
    }
    entries.push(entry);

    if (
      options.includeAssets &&
      body.length > 0 &&
      body.length <= options.maxAssetBytes
    ) {
      const url = request.url();
      const category = categoryForAsset(mimeType, url);
      if (category && !assetUrls.has(url)) {
        assetUrls.add(url);
        const path = assetPathFor(url, mimeType, assetCount);
        let uniquePath = path;
        while (usedPaths.has(uniquePath)) {
          uniquePath = uniquePath.replace(/\.([^.]+)$/, '-2.$1');
        }
        usedPaths.add(uniquePath);
        files.push({path: uniquePath, data: body});
        assetCount++;
      }
    }
  }

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'chrome-devtools-mcp export_everything',
        version: '1.0.0',
      },
      pages: [],
      entries,
    },
    bodyBytes,
    assetCount,
  };
}

function toConsoleRecord(item: ConsoleItem): ConsoleRecord {
  if (item instanceof Error) {
    return {
      level: 'error',
      text: item.message,
      stack: item.stack ?? '',
      url: '',
      timestamp: Date.now(),
    };
  }
  if (item instanceof ConsoleMessage) {
    const location = item.location();
    return {
      level: item.type(),
      text: item.text(),
      url: location.url ?? '',
      timestamp: Date.now(),
    };
  }
  return {
    level: 'log',
    text: JSON.stringify(item) ?? '',
    url: '',
    timestamp: Date.now(),
  };
}

async function readStorage(
  page: Page,
): Promise<Record<string, unknown> | null> {
  try {
    return await page.evaluate(async () => {
      const output: Record<string, unknown> = {
        localStorage: {},
        sessionStorage: {},
        indexedDB: [],
        caches: [],
        estimate: null,
        errors: [],
      };
      const errors: string[] = [];

      function read(store: Storage, target: Record<string, string>): void {
        try {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key === null) {
              continue;
            }
            const value = store.getItem(key);
            if (value !== null) {
              target[key] = value;
            }
          }
        } catch (error) {
          errors.push(String(error));
        }
      }

      const local: Record<string, string> = {};
      const session: Record<string, string> = {};
      read(localStorage, local);
      read(sessionStorage, session);
      output.localStorage = local;
      output.sessionStorage = session;

      function safeValue(value: unknown, depth: number): unknown {
        if (value === null || typeof value !== 'object') {
          return value;
        }
        if (depth > 3) {
          return '[depth limit]';
        }
        if (value instanceof Date) {
          return value.toISOString();
        }
        if (value instanceof Blob) {
          return {__type: 'Blob', type: value.type, size: value.size};
        }
        if (value instanceof ArrayBuffer) {
          return {__type: 'ArrayBuffer', bytes: value.byteLength};
        }
        if (ArrayBuffer.isView(value)) {
          return {__type: value.constructor.name, length: value.byteLength};
        }
        if (Array.isArray(value)) {
          return value.slice(0, 200).map(item => safeValue(item, depth + 1));
        }
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).slice(0, 50)) {
          try {
            result[key] = safeValue(Reflect.get(value, key), depth + 1);
          } catch {
            result[key] = '[throws]';
          }
        }
        return result;
      }

      async function dumpDatabase(name: string): Promise<unknown> {
        return await new Promise(resolve => {
          let settled = false;
          const finish = (value: unknown): void => {
            if (settled) {
              return;
            }
            settled = true;
            resolve(value);
          };
          const timer = setTimeout(
            () => finish({name, error: 'timeout'}),
            5000,
          );
          let request: IDBOpenDBRequest;
          try {
            request = indexedDB.open(name);
          } catch (error) {
            clearTimeout(timer);
            finish({name, error: String(error)});
            return;
          }
          request.onerror = () => {
            clearTimeout(timer);
            finish({name, error: 'open failed'});
          };
          request.onsuccess = () => {
            const db = request.result;
            const stores = Array.from(db.objectStoreNames);
            const storesOut: unknown[] = [];
            const result: Record<string, unknown> = {
              name,
              version: db.version,
              stores: storesOut,
            };
            if (!stores.length) {
              clearTimeout(timer);
              db.close();
              finish(result);
              return;
            }
            let pending = stores.length;
            const maybeDone = (): void => {
              pending--;
              if (pending > 0) {
                return;
              }
              clearTimeout(timer);
              db.close();
              finish(result);
            };
            for (const storeName of stores) {
              const tx = db.transaction(storeName, 'readonly');
              const store = tx.objectStore(storeName);
              const rows: unknown[] = [];
              let count = 0;
              const cursorRequest = store.openCursor();
              const finishStore = (error?: string): void => {
                storesOut.push({
                  name: storeName,
                  keyPath: store.keyPath,
                  rows,
                  truncated: Boolean(cursorRequest.result),
                  ...(error ? {error} : {}),
                });
                maybeDone();
              };
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor || count >= 200) {
                  finishStore();
                  return;
                }
                rows.push({
                  key: safeValue(cursor.primaryKey, 0),
                  value: safeValue(cursor.value, 0),
                });
                count++;
                cursor.continue();
              };
              cursorRequest.onerror = () => finishStore('read failed');
            }
          };
        });
      }

      if (indexedDB.databases) {
        try {
          const databases = await indexedDB.databases();
          const dumps: unknown[] = [];
          for (const info of databases.slice(0, 50)) {
            if (info.name) {
              dumps.push(await dumpDatabase(info.name));
            }
          }
          output.indexedDB = dumps;
        } catch (error) {
          errors.push(`indexedDB: ${String(error)}`);
        }
      }

      if (window.caches) {
        try {
          output.caches = await caches.keys();
        } catch (error) {
          errors.push(`caches: ${String(error)}`);
        }
      }

      if (navigator.storage && navigator.storage.estimate) {
        try {
          output.estimate = await navigator.storage.estimate();
        } catch (error) {
          errors.push(`estimate: ${String(error)}`);
        }
      }

      output.errors = errors;
      return output;
    });
  } catch {
    return null;
  }
}

function addText(files: ZipEntry[], path: string, text: string): void {
  files.push({path, data: new TextEncoder().encode(text)});
}

function addJson(files: ZipEntry[], path: string, value: unknown): void {
  addText(files, path, JSON.stringify(value, null, 2));
}

function readmeText(): string {
  return [
    'EXPORT EVERYTHING — complete capture from chrome-devtools-mcp',
    '',
    'har/page.har                 Full HAR with response bodies (base64) and headers.',
    'cookies/cookies.json         Chrome-shaped cookie objects with HttpOnly/partition data.',
    'cookies/cookies.j2team.json  J2TEAM Cookies-compatible JSON.',
    'cookies/cookies.txt          Netscape cookies.txt (curl/J2TEAM).',
    'page/dom.html                Live DOM at export time.',
    'page/page.json               Metadata, images, backgrounds and counts.',
    'page/page.mhtml              MHTML snapshot captured through CDP.',
    'page/screenshot.png          Viewport screenshot.',
    'page/screenshot-full.png     Full-page screenshot.',
    'console/console.jsonl       Console entries, one JSON object per line.',
    'console/console.txt         Human-readable console log.',
    'storage/storage.json         localStorage, sessionStorage, IndexedDB, caches.',
    'assets/...                   Images, fonts, media and PDFs from response bodies.',
    'manifest.json                Counts, options, warnings and file list.',
    '',
    'Cookies and the HAR contain authentication material. Keep this archive secret.',
    '',
  ].join('\n');
}

/**
 * Builds the complete archive without writing it to disk. The tool handler calls
 * `Context.saveFile` with the returned ZIP bytes.
 */
export async function buildExportArchive(
  page: Page,
  contextPage: ContextPage,
  options: ExportEverythingOptions,
): Promise<ExportEverythingResult> {
  const files: ZipEntry[] = [];
  const warnings: string[] = [];
  const usedPaths = new Set<string>();
  const pageUrl = page.url();
  const title = await page.title();
  const session = await page.createCDPSession();
  let harEntries = 0;
  let cookieCount = 0;
  let consoleEntries = 0;
  let assetCount = 0;

  try {
    const cookies = await collectCookies(
      page,
      session,
      options.includeAllCookies,
      pageUrl,
      warnings,
    );
    cookieCount = cookies.length;
    addJson(files, 'cookies/cookies.json', cookies);
    addJson(
      files,
      'cookies/cookies.j2team.json',
      cookies.map(cookie => ({
        domain: cookie.domain,
        expirationDate: cookie.expirationDate,
        hostOnly: cookie.hostOnly,
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite,
        secure: cookie.secure,
        session: cookie.session,
        storeId: cookie.storeId,
        value: cookie.value,
        ...(cookie.partitionKey ? {partitionKey: cookie.partitionKey} : {}),
      })),
    );
    addText(files, 'cookies/cookies.txt', cookiesToNetscape(cookies));

    const har = await buildHar(
      contextPage.getNetworkRequests(),
      options,
      files,
      usedPaths,
      warnings,
    );
    harEntries = har.log.entries.length;
    assetCount = har.assetCount;
    addText(files, 'har/page.har', JSON.stringify({log: har.log}));

    const dom = await page.content();
    addText(files, 'page/dom.html', dom);

    const metadata = await page.evaluate(() => {
      const absolute = (value: string): string => {
        try {
          return new URL(value, location.href).href;
        } catch {
          return value;
        }
      };
      const images: Array<Record<string, unknown>> = [];
      for (const image of Array.from(document.images)) {
        const src = image.currentSrc || image.src;
        if (!src) {
          continue;
        }
        images.push({
          src: absolute(src),
          srcset: image.srcset,
          alt: image.alt,
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
      }
      const backgrounds = new Set<string>();
      for (const element of Array.from(document.querySelectorAll('*'))) {
        const style = getComputedStyle(element);
        for (const property of [
          'backgroundImage',
          'borderImageSource',
          'listStyleImage',
        ]) {
          const value = style.getPropertyValue(property);
          if (!value || value === 'none' || !value.includes('url(')) {
            continue;
          }
          const regex = /url\((['"]?)(.*?)\1\)/g;
          let match: RegExpExecArray | null = null;
          while ((match = regex.exec(value)) !== null) {
            if (match[2] && !match[2].startsWith('data:')) {
              backgrounds.add(absolute(match[2]));
            }
          }
        }
      }
      return {
        url: location.href,
        title: document.title,
        referrer: document.referrer,
        readyState: document.readyState,
        charset: document.characterSet,
        userAgent: navigator.userAgent,
        language: navigator.language,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        },
        counts: {
          elements: document.querySelectorAll('*').length,
          images: document.images.length,
          links: document.links.length,
          scripts: document.scripts.length,
          forms: document.forms.length,
          iframes: document.querySelectorAll('iframe').length,
        },
        images,
        backgroundUrls: Array.from(backgrounds),
        forms: Array.from(document.forms).map(form => ({
          action: absolute(form.action),
          method: form.method,
          id: form.id,
          name: form.name,
        })),
      };
    });
    addJson(files, 'page/page.json', metadata);

    try {
      const snapshot = await session.send('Page.captureSnapshot', {
        format: 'mhtml',
      });
      addText(files, 'page/page.mhtml', snapshot.data);
    } catch (error) {
      warnings.push(
        `MHTML snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (options.includeScreenshots) {
      try {
        const viewport = await page.screenshot({type: 'png', fullPage: false});
        files.push({path: 'page/screenshot.png', data: viewport});
      } catch (error) {
        warnings.push(
          `viewport screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        const full = await page.screenshot({type: 'png', fullPage: true});
        files.push({path: 'page/screenshot-full.png', data: full});
      } catch (error) {
        warnings.push(
          `full-page screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const consoleItems = contextPage.getConsoleData(false);
    consoleEntries = consoleItems.length;
    const consoleRecords = consoleItems.map(item => toConsoleRecord(item));
    addText(
      files,
      'console/console.jsonl',
      consoleRecords.map(record => JSON.stringify(record)).join('\n') +
        (consoleRecords.length ? '\n' : ''),
    );
    addText(
      files,
      'console/console.txt',
      consoleRecords
        .map(record => {
          const stack = record.stack ? `\n${record.stack}` : '';
          return `[${new Date(record.timestamp).toISOString()}] ${record.level.toUpperCase()} ${record.url}\n${record.text}${stack}`;
        })
        .join('\n\n'),
    );

    if (options.includeStorage) {
      const storage = await readStorage(page);
      addJson(files, 'storage/storage.json', storage ?? {error: 'unavailable'});
    }

    addText(files, 'README.txt', readmeText());

    const totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
    const manifest: ExportManifest = {
      tool: 'chrome-devtools-mcp export_everything',
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      page: {url: pageUrl, title},
      options,
      counts: {
        harEntries,
        cookies: cookieCount,
        consoleEntries,
        assets: assetCount,
        files: files.length + 1,
        bytes: totalBytes,
      },
      warnings,
      files: files.map(file => ({path: file.path, size: file.data.length})),
    };
    addJson(files, 'manifest.json', manifest);

    const zip = createZip(files);
    return {zip, manifest};
  } finally {
    await session.detach();
  }
}
