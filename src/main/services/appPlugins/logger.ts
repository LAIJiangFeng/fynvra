// 插件日志：前缀 `[plugin:<id>]`，每插件每秒最多 100 行（超出丢弃，下一秒补一行丢弃条数），输出前抹掉该插件的密钥。
import type { PluginLogLevel } from '@shared/types/appPluginApi';

export const MAX_LOG_LINES_PER_SECOND = 100;
const MAX_LINE_CHARS = 8 * 1024;

export type LogSink = (level: PluginLogLevel, line: string) => void;

export interface PluginLogger {
  /** 一条消息可含多行，按行计数 */
  write(pluginId: string, level: PluginLogLevel, message: string): void;
}

const defaultSink: LogSink = (level, line) => {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join('***');
  }
  return result;
}

export function createPluginLogger(deps: {
  secrets: (pluginId: string) => readonly string[];
  sink?: LogSink;
  now?: () => number;
}): PluginLogger {
  const { secrets, sink = defaultSink, now = Date.now } = deps;
  const windows = new Map<string, { second: number; count: number; dropped: number }>();

  return {
    write(pluginId, level, message) {
      const second = Math.floor(now() / 1000);
      let window = windows.get(pluginId);
      if (!window || window.second !== second) {
        if (window && window.dropped > 0) {
          sink('warn', `[plugin:${pluginId}] dropped ${window.dropped} log lines (rate limit)`);
        }
        window = { second, count: 0, dropped: 0 };
        windows.set(pluginId, window);
      }
      const own = secrets(pluginId);
      for (const raw of message.split(/\r?\n/)) {
        if (raw === '') continue;
        if (window.count >= MAX_LOG_LINES_PER_SECOND) {
          window.dropped += 1;
          continue;
        }
        window.count += 1;
        sink(level, `[plugin:${pluginId}] ${redactSecrets(raw, own).slice(0, MAX_LINE_CHARS)}`);
      }
    },
  };
}
