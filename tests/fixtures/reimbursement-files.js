import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BlobReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { ATTACHMENT_HEADERS, READY_HEADERS } from '../../dist/main/reimbursement/csv-v2.js';

export const railNumber = '00123456789012345678';
export const taxiNumber = '00987654321098765432';
export const railText = [
  '铁路电子客票', '发票号码：' + railNumber, '开票日期：2026年11月24日',
  '乘车日期：2026年11月21日 G123 09:30 开车', '票价：¥320.50',
];
export const taxiText = [
  '电子发票（普通发票）', '发票号码：' + taxiNumber, '开票日期：2026年11月23日',
  '网约车 客运服务', '合计 ¥56.20 ¥0.00', '价税合计（小写）¥56.20',
];
export const supportText = [
  '滴滴出行 行程单', '行程起止日期：2026-11-21至2026-11-24', '共1笔行程', '合计 ¥56.20 元',
];

export function pdfWithText(lines) {
  // Explicit Unicode mapping for a synthetic Chinese text-layer invoice.
  const hex = (line) => Buffer.from(line, 'utf16le').swap16().toString('hex');
  const content = ['BT /F1 19 Tf', ...lines.map((line, i) => '1 0 0 1 40 ' + (455 - i * 54) + ' Tm <' + hex(line) + '> Tj'), 'ET'].join('\n');
  const chars = [...new Set(lines.join(''))];
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /SyntheticUnicode def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    chars.length + ' beginbfchar', ...chars.map((char) => '<' + hex(char) + '> <' + hex(char) + '>'),
    'endbfchar', 'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 500] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 8 0 R /DW 1000 >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    '<< /Length ' + cmap.length + ' >>\nstream\n' + cmap + '\nendstream',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-30 -250 1090 860] /ItalicAngle 0 /Ascent 880 /Descent -225 /CapHeight 700 /StemV 90 >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    offsets.push(String(output.length).padStart(10, '0') + ' 00000 n \n');
    output += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const start = output.length;
  output += 'xref\n0 ' + offsets.length + '\n' + offsets.join('') + 'trailer\n<< /Size ' + offsets.length +
    ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(output, 'ascii');
}

export async function writeZip(file, entries) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes, options] of entries) {
    await zip.add(name, new BlobReader(new Blob([bytes])), options);
  }
  await writeFile(file, await zip.close());
}

export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const csv = (rows) => '\uFEFF' + rows.map((line) => line.map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';

export async function reimbursementFiles(folder) {
  await mkdir(folder, { recursive: true });
  const direct = join(folder, '高铁原件.pdf');
  const bundledTaxi = pdfWithText(taxiText);
  const bundledRail = pdfWithText(railText);
  const bundledSupport = pdfWithText(supportText);
  const zip = join(folder, '差旅材料 合成.zip');
  await writeFile(direct, bundledRail);
  await writeZip(zip, [
    ['交通/同一张高铁.pdf', bundledRail],
    ['交通/网约车.pdf', bundledTaxi],
    ['附件/滴滴行程单.pdf', bundledSupport],
    ['附件/readme.txt', 'Synthetic PDF fixture'],
  ]);
  const taxiFile = join(folder, '网约车,原件.pdf');
  await writeFile(taxiFile, bundledTaxi);
  const ready = join(folder, '可填写清单.csv');
  const readyRow = [
    '1', '差旅费', '出租车费', '2026-11-23', '增值税电子普通发票', '56.20', '0.00', taxiNumber, '网约车,原件.pdf',
    '出行，例子 "A"\n第二行', '2', 'sample-csv-1', '出租车电子票', '自动', '开票日期', '2026-11-23', '', '',
    '', '票面税额已录入', 'C:/not-used', '网约车,原件.pdf', '1', '复核备注',
  ];
  const attachment = ['2', 'sample-csv-1', '1', '发票原件', 'sample-csv-1', 'C:/not-used', '网约车,原件.pdf', '1', sha(bundledTaxi), '原件'];
  await writeFile(ready, csv([READY_HEADERS, readyRow]));
  await writeFile(join(folder, '附件清单.csv'), csv([ATTACHMENT_HEADERS, attachment]));
  return { direct, zip, ready, taxiFile, bundledSupport, bundledTaxi, readyRow, attachment };
}
