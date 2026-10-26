import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { UsageRange, UsageSummary } from '@shared/types/usage';
import { aggregateUsage, createFileAccumulator, type FileUsage } from './aggregate';

/** A bad/unreadable file is skipped, and retried on the next refresh. */
export async function readUsageFile(path: string): Promise<FileUsage | null> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const accumulator = createFileAccumulator();
  try {
    for await (const line of lines) accumulator.add(line);
    return accumulator.finish();
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  usage: FileUsage;
}

export class UsageService {
  private readonly cache = new Map<string, CacheEntry>();
  private pending: Promise<FileUsage[]> | null = null;

  constructor(
    private readonly directory: string,
    private readonly readFile: (path: string) => Promise<FileUsage | null> = readUsageFile,
    private readonly now: () => number = Date.now
  ) {}

  async summary(range: UsageRange): Promise<UsageSummary> {
    // Coalesce simultaneous window/range requests, so changed files are read only once.
    const pending = this.pending ?? this.scan();
    this.pending = pending;
    try {
      return aggregateUsage(await pending, range, this.now());
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  private async scan(): Promise<FileUsage[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    );
    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => join(this.directory, entry.name));
    const present = new Set(paths);
    for (const path of this.cache.keys()) if (!present.has(path)) this.cache.delete(path);
    const files: FileUsage[] = [];
    // Stream one file at a time to avoid exhausting descriptors on large session libraries.
    for (const path of paths) {
      try {
        const info = await stat(path);
        const cached = this.cache.get(path);
        if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) {
          files.push(cached.usage);
          continue;
        }
        this.cache.delete(path);
        const usage = await this.readFile(path);
        if (!usage) continue;
        this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, usage });
        files.push(usage);
      } catch {
        // Removal, replacement or permission changes in one file cannot break the summary.
        this.cache.delete(path);
      }
    }
    return files;
  }
}
