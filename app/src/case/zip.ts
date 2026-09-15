/**
 * 最小 ZIP 读取器（仅解压，用 node:zlib，不引入第三方依赖）。
 *
 * 除了解包，它承担 contracts/README.md 要求的输入安全校验：
 * 拒绝绝对路径、`..` 穿越、反斜杠路径、软链接、超限文件与超限条目数；
 * 每个条目都核对 CRC-32 与解压后长度，损坏的包不会被当成有效输入。
 */

import zlib from "node:zlib";

export interface ZipEntry {
  /** 包内相对路径，使用 `/` 分隔。 */
  path: string;
  bytes: Buffer;
}

export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 64,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/* ── CRC-32 ─────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── 路径校验 ───────────────────────────────────────────────────────────── */

/** 校验包内路径；返回规范化后的路径，不合法则抛错。 */
export function assertSafeEntryPath(raw: string): string {
  const name = raw.normalize("NFC");
  if (!name) throw new ZipError("压缩包内存在空文件名");
  if (name.includes("\0")) throw new ZipError(`文件名含空字符：${JSON.stringify(raw)}`);
  if (name.includes("\\")) throw new ZipError(`文件名使用反斜杠分隔：${raw}`);
  if (name.startsWith("/")) throw new ZipError(`压缩包内是绝对路径：${raw}`);
  if (/^[A-Za-z]:/.test(name)) throw new ZipError(`压缩包内是盘符路径：${raw}`);
  const segments = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) throw new ZipError(`压缩包内路径越界（..）：${raw}`);
  return segments.join("/");
}

/* ── 解包 ───────────────────────────────────────────────────────────────── */

interface CentralEntry {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  unixMode: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipError("不是有效的 ZIP：找不到中央目录结束记录");
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    throw new ZipError("不支持 ZIP64 压缩包，请重新打包为标准 ZIP");
  }
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new ZipError("ZIP 中央目录损坏");
    }
    const versionMadeBy = buf.readUInt16LE(offset + 4);
    const method = buf.readUInt16LE(offset + 10);
    const crc = buf.readUInt32LE(offset + 16);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    const platform = versionMadeBy >> 8;
    const unixMode = platform === 3 ? (externalAttrs >>> 16) & 0xffff : 0;
    entries.push({ path: name, method, crc, compressedSize, uncompressedSize, localOffset, unixMode });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压 ZIP，返回包内文件列表（目录条目不返回）。 */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const central = readCentralDirectory(buf);
  if (central.length > limits.maxEntries) {
    throw new ZipError(`压缩包条目过多：${central.length} > ${limits.maxEntries}`);
  }
  const seen = new Set<string>();
  const files: ZipEntry[] = [];
  let total = 0;

  for (const entry of central) {
    if (entry.path.endsWith("/")) continue; // 目录条目
    const mode = entry.unixMode & 0xf000;
    if (mode === 0xa000) throw new ZipError(`压缩包内含软链接：${entry.path}`);
    if (mode !== 0 && mode !== 0x8000) throw new ZipError(`压缩包内含非普通文件：${entry.path}`);

    const safe = assertSafeEntryPath(entry.path);
    if (seen.has(safe)) throw new ZipError(`压缩包内路径重复：${safe}`);
    seen.add(safe);

    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new ZipError(`${safe} 超过单文件上限 ${limits.maxFileBytes} 字节`);
    }
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${safe} 使用了不支持的压缩方式（method=${entry.method}）`);
    }
    if (entry.localOffset + 30 > buf.length || buf.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      throw new ZipError(`${safe} 的本地文件头损坏`);
    }
    const localNameLen = buf.readUInt16LE(entry.localOffset + 26);
    const localExtraLen = buf.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + entry.compressedSize);
    if (raw.length !== entry.compressedSize) throw new ZipError(`${safe} 数据被截断`);
    let data: Buffer;
    try {
      data = entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    } catch {
      throw new ZipError(`${safe} 解压失败：文件可能损坏`);
    }
    if (data.length !== entry.uncompressedSize) throw new ZipError(`${safe} 解压后长度与记录不符`);
    if (crc32(data) !== entry.crc) throw new ZipError(`${safe} CRC-32 校验失败`);

    total += data.length;
    if (total > limits.maxTotalBytes) {
      throw new ZipError(`压缩包解压后总大小超过上限 ${limits.maxTotalBytes} 字节`);
    }
    files.push({ path: safe, bytes: data });
  }
  return files;
}
