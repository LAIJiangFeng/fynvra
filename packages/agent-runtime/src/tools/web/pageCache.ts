export interface CachedPage {
  /** 最终 URL */
  url: string;
  redirectedFrom?: string;
  title?: string;
  contentType: string;
  text: string;
  notes: string[];
}

export interface PageCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  /** 正文总量上限（UTF-16 字节估算） */
  maxBytes?: number;
  now?: () => number;
}

interface Entry {
  page: CachedPage;
  size: number;
  expiresAt: number;
}

/** 转换结果的 LRU：分页继续读取时不重复下载。只缓存成功结果，键为请求 URL */
export class PageCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: PageCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 32;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
    this.now = options.now ?? Date.now;
  }

  get(key: string): CachedPage | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // 移到末尾 = 最近使用
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.page;
  }

  set(key: string, page: CachedPage): void {
    const size = sizeOf(page);
    this.delete(key);
    if (size > this.maxBytes) return;
    this.entries.set(key, { page, size, expiresAt: this.now() + this.ttlMs });
    this.bytes += size;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      this.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.size;
  }
}

function sizeOf(page: CachedPage): number {
  return (
    2 *
    (page.text.length +
      page.url.length +
      (page.redirectedFrom?.length ?? 0) +
      (page.title?.length ?? 0) +
      page.contentType.length +
      page.notes.reduce((total, note) => total + note.length, 0))
  );
}
