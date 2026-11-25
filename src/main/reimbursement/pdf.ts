import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { ReimbursementError } from './batch.js';
import { verifiedPdf } from './sources.js';
import type { StoredPdf } from './sources.js';

const require = createRequire(import.meta.url);
const maxPages = 100;
const maxImageSize = 32_000_000;

async function withDocument<T>(source: StoredPdf, action: (document: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const resources = dirname(require.resolve('pdfjs-dist/package.json'));
  const resourcePath = (name: string) => join(resources, name).replaceAll('\\', '/') + '/';
  const task = getDocument({
    data: Uint8Array.from(await verifiedPdf(source)),
    cMapUrl: resourcePath('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: resourcePath('standard_fonts'),
    wasmUrl: resourcePath('wasm'),
    useWorkerFetch: false,
    maxImageSize,
  });
  try {
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > maxPages) {
      throw new ReimbursementError('PDF 页数超出导入范围，请拆分后重新选择');
    }
    return await action(document);
  } catch (error) {
    if (error instanceof ReimbursementError) throw error;
    throw new ReimbursementError('无法解析 PDF，请核对文件是否加密或损坏');
  } finally {
    await task.destroy();
  }
}

export function readPdfPages(source: StoredPdf): Promise<string[]> {
  return withDocument(source, async (document) => {
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      let text = '';
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(y - lastY) > Math.max(2, item.height * 0.45)) text += '\n';
        text += item.str + (item.hasEOL ? '\n' : ' ');
        lastY = y;
      }
      // Some text layers expose raw font bytes when they lack a Unicode map.
      // Leave those pages for manual review instead of parsing byte fragments.
      pages.push(/[\u0000-\u0008]/u.test(text) ? '' : text);
      page.cleanup();
    }
    return pages;
  });
}

export function renderPdfPage(source: StoredPdf, index: number): Promise<{ png: string; pages: number }> {
  return withDocument(source, async (document) => {
    if (index > document.numPages) throw new ReimbursementError('PDF 没有该页');
    const page = await document.getPage(index);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 1400 / Math.max(natural.width, natural.height, 1) });
    type Surface = {
      canvas: HTMLCanvasElement & { toBuffer(format: 'image/png'): Buffer };
      context: CanvasRenderingContext2D;
    };
    const factory = document.canvasFactory as {
      create(width: number, height: number): Surface;
      destroy(surface: Surface): void;
    };
    const canvas = factory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
    try {
      await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport }).promise;
      return { png: canvas.canvas.toBuffer('image/png').toString('base64'), pages: document.numPages };
    } finally {
      factory.destroy(canvas);
    }
  });
}
