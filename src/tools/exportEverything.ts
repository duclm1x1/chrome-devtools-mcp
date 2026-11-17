/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import {buildExportArchive} from '../utils/exportEverything.js';

import {ToolCategory} from './categories.js';
import {definePageTool, type PageToolFactory} from './ToolDefinition.js';

const DEFAULT_MAX_ASSET_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BODY_BYTES = 512 * 1024 * 1024;

export const exportEverything: PageToolFactory = definePageTool(() => ({
  name: 'export_everything',
  description: `Writes a complete local archive of the inspected page: HAR with response bodies, cookies (Chrome/J2TEAM/Netscape), live DOM, MHTML snapshot, console, storage, screenshots and image/font/media assets. Returns the saved ZIP path. Everything is read from the MCP network/console collectors and CDP; no network upload is performed.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod
      .string()
      .optional()
      .describe(
        'Absolute path, or a path relative to the current working directory, for the ZIP archive. Defaults to export-everything.zip.',
      ),
    includeAllCookies: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Export every cookie in the browser profile instead of only the inspected site and its subdomains.',
      ),
    includeBodies: zod
      .boolean()
      .default(true)
      .optional()
      .describe(
        'Include response bodies in the HAR and recover asset files from them. Disable to reduce archive size.',
      ),
    includeAssets: zod
      .boolean()
      .default(true)
      .optional()
      .describe(
        'Write images, fonts, audio/video and PDFs to assets/ inside the archive. Requires includeBodies.',
      ),
    includeStorage: zod
      .boolean()
      .default(true)
      .optional()
      .describe(
        'Include localStorage, sessionStorage, IndexedDB (up to 200 rows per store) and CacheStorage keys.',
      ),
    includeScreenshots: zod
      .boolean()
      .default(true)
      .optional()
      .describe('Include viewport and full-page PNG screenshots.'),
    maxAssetBytes: zod
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_ASSET_BYTES)
      .optional()
      .describe(
        `Maximum size of a single asset written to assets/. Defaults to ${DEFAULT_MAX_ASSET_BYTES} bytes.`,
      ),
    maxTotalBodyBytes: zod
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_TOTAL_BODY_BYTES)
      .optional()
      .describe(
        `Maximum combined response-body bytes included in the HAR. Defaults to ${DEFAULT_MAX_TOTAL_BODY_BYTES} bytes.`,
      ),
  },
  blockedByDialog: true,
  concurrency: 'exclusive',
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response, context) => {
    const result = await buildExportArchive(
      request.page.pptrPage,
      request.page,
      {
        includeAllCookies: request.params.includeAllCookies ?? false,
        includeBodies: request.params.includeBodies ?? true,
        includeAssets: request.params.includeAssets ?? true,
        includeStorage: request.params.includeStorage ?? true,
        includeScreenshots: request.params.includeScreenshots ?? true,
        maxAssetBytes: request.params.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
        maxTotalBodyBytes:
          request.params.maxTotalBodyBytes ?? DEFAULT_MAX_TOTAL_BODY_BYTES,
      },
    );

    const saved = await context.saveFile(
      result.zip,
      request.params.filePath ?? 'export-everything.zip',
      '.zip',
    );

    response.appendResponseLine(
      `Saved complete export to ${saved.filename} (${result.manifest.counts.files} files, ${result.manifest.counts.bytes} bytes).`,
    );
    response.appendResponseLine(
      `HAR entries: ${result.manifest.counts.harEntries}; cookies: ${result.manifest.counts.cookies}; console: ${result.manifest.counts.consoleEntries}; assets: ${result.manifest.counts.assets}.`,
    );
    if (result.manifest.warnings.length) {
      response.appendResponseLine(
        `Warnings: ${result.manifest.warnings.length} (see manifest.json).`,
      );
    }
  },
}));
