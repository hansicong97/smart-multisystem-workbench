import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { BlobReader, ZipReader } from '@zip.js/zip.js';
import type { ImportIssue, PdfSource } from '../../shared/reimbursement.js';
import { ReimbursementError } from './batch.js';

const MiB = 1024 * 1024;
export const IMPORT_LIMITS = {
  entries: 500,
  pdfBytes: 25 * MiB,
  batchBytes: 200 * MiB,
  archiveBytes: 256 * MiB,
};
type Limits = typeof IMPORT_LIMITS;

export interface StoredPdf extends PdfSource {
  path: string;
}

interface Candidate {
  name: string;
  label: string;
  read: (write: (bytes: Uint8Array) => Promise<void>) => Promise<void>;
  expectedHash?: string;
}

export function directPdf(path: string, label = basename(path), expectedHash?: string): Candidate {
  return {
    name: basename(path), label, expectedHash,
    async read(write) {
      if (!(await stat(path)).isFile()) throw new ReimbursementError('请选用普通 PDF 文件');
      for await (const bytes of createReadStream(path)) await write(bytes);
    },
  };
}

export class SourceStore {
  #sources = new Map<string, StoredPdf>();
  #inflated = 0;

  constructor(private readonly folder: string, private readonly limits = IMPORT_LIMITS) {}

  get sources(): StoredPdf[] { return [...this.#sources.values()]; }

  async add(candidate: Candidate, inspect?: (source: StoredPdf) => Promise<void>): Promise<StoredPdf> {
    const path = join(this.folder, randomUUID() + '.pdf');
    const handle = await open(path, 'wx', 0o600);
    let kept = false;
    let size = 0;
    let header = Buffer.alloc(0);
    const hash = createHash('sha256');
    try {
      try {
        await candidate.read(async (bytes) => {
          size += bytes.byteLength;
          this.#inflated += bytes.byteLength;
          if (size > this.limits.pdfBytes) throw new ReimbursementError('单个 PDF 超过导入大小上限');
          if (this.#inflated > this.limits.batchBytes) throw new ReimbursementError('批次超出解压后大小上限');
          if (header.length < 1024) header = Buffer.concat([header, bytes.subarray(0, 1024 - header.length)]);
          hash.update(bytes);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
            if (!bytesWritten) throw new Error('short PDF write');
            offset += bytesWritten;
          }
        });
      } finally {
        await handle.close();
      }
      if (!header.includes('%PDF-')) throw new ReimbursementError('文件内容不是 PDF');
      const sha256 = hash.digest('hex');
      if (candidate.expectedHash && candidate.expectedHash !== sha256) {
        throw new ReimbursementError('原件指纹与附件清单不一致，请重新定位或导出清单');
      }
      const existing = this.#sources.get(sha256);
      if (existing) {
        if (!existing.locations.includes(candidate.label)) existing.locations.push(candidate.label);
        return existing;
      }
      const source = { id: sha256, path, name: candidate.name, locations: [candidate.label], size, sha256 };
      await inspect?.(source);
      this.#sources.set(sha256, source);
      kept = true;
      return source;
    } finally {
      if (!kept) await rm(path, { force: true });
    }
  }
}

function safeZipName(name: string) {
  return !/[:\\\0]/u.test(name) && name.split('/').every((part) => part && part !== '..' && part !== '.');
}

function issue(label: string, message: string, kind: ImportIssue['kind']): ImportIssue {
  return { id: randomUUID(), label, message, kind, excluded: false };
}

function problem(error: unknown, fallback: string): string {
  return error instanceof ReimbursementError ? error.message : fallback;
}

export async function importPdfSources(
  paths: string[],
  folder: string,
  inspect: (source: StoredPdf) => Promise<void>,
  update: (done: number, total: number) => void,
  limits: Limits = IMPORT_LIMITS,
): Promise<{ sources: StoredPdf[]; issues: ImportIssue[] }> {
  const store = new SourceStore(folder, limits);
  const issues: ImportIssue[] = [];
  let entries = 0;
  for (const [index, path] of paths.entries()) {
    update(index, paths.length);
    const name = basename(path);
    if (entries >= limits.entries) {
      issues.push(issue(name, '批次文件条目已达上限，请分批导入', 'failed'));
      break;
    }
    if (extname(name).toLowerCase() === '.pdf') {
      entries += 1;
      try {
        await store.add(directPdf(path), inspect);
      } catch (error) {
        issues.push(issue(name, problem(error, '无法读取或解析 PDF'), 'failed'));
      }
      continue;
    }
    if (extname(name).toLowerCase() !== '.zip') {
      issues.push(issue(name, '请选择 PDF 或 ZIP', 'skipped'));
      continue;
    }
    try {
      const archive = await openAsBlob(path);
      if (archive.size > limits.archiveBytes) throw new ReimbursementError('ZIP 超过导入大小上限');
      const reader = new ZipReader(new BlobReader(archive), { useWebWorkers: false });
      try {
        const usedNames = new Map<string, number>();
        for await (const entry of reader.getEntriesGenerator()) {
          entries += 1;
          if (entries > limits.entries) throw new ReimbursementError('批次文件条目已达上限，请分批导入');
          if (entry.directory) continue;
          const counter = (usedNames.get(entry.filename) ?? 0) + 1;
          usedNames.set(entry.filename, counter);
          const label = name + ' › ' + entry.filename + (counter > 1 ? '（同名条目 ' + counter + '）' : '');
          if (!safeZipName(entry.filename)) {
            issues.push(issue(label, 'ZIP 条目路径无效', 'failed'));
            continue;
          }
          const fileKind = (entry.unixMode ?? 0) & 0o170000;
          if (fileKind !== 0 && fileKind !== 0o100000) {
            issues.push(issue(label, '只读取 ZIP 内的普通文件', 'skipped'));
            continue;
          }
          if (extname(entry.filename).toLowerCase() !== '.pdf') {
            issues.push(issue(label, '已跳过非 PDF 文件', 'skipped'));
            continue;
          }
          if (entry.encrypted || entry.uncompressedSize > limits.pdfBytes) {
            issues.push(issue(label, entry.encrypted ? '暂不支持加密 ZIP 条目' : '单个 PDF 超过导入大小上限', 'failed'));
            continue;
          }
          try {
            await store.add({
              name: basename(entry.filename), label,
              async read(write) {
                let sinkError: unknown;
                const sink = new WritableStream<Uint8Array>({
                  async write(bytes) {
                    try { await write(bytes); } catch (error) { sinkError = error; throw error; }
                  },
                });
                try {
                  await entry.getData(sink, { checkSignature: true, useWebWorkers: false });
                } catch (error) {
                  throw sinkError ?? error;
                }
              },
            }, inspect);
          } catch (error) {
            issues.push(issue(label, problem(error, 'ZIP 条目损坏或无法解析 PDF'), 'failed'));
          }
        }
      } finally {
        await reader.close();
      }
    } catch (error) {
      issues.push(issue(name, problem(error, '无法读取 ZIP，请核对压缩包是否完整'), 'failed'));
    }
  }
  update(paths.length, paths.length);
  return { sources: store.sources, issues };
}

export async function verifiedPdf(source: StoredPdf): Promise<Buffer> {
  try {
    if ((await stat(source.path)).size !== source.size) throw new Error();
    const bytes = await readFile(source.path);
    if (bytes.length !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error();
    return bytes;
  } catch {
    throw new ReimbursementError('原件缓存不可用，请重新导入对应的 PDF 或 ZIP');
  }
}
