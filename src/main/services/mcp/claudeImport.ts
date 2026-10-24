import { asRecord, errorMessage } from '@shared/guards';
import type { McpImportSource } from '../../../preload/domains/mcp';
import { parseJsonc } from './import/jsonc';
import { locateMcpSources, readTextIfExists } from './import/locate';
import { claudeConfigServers } from './import/readers/claudeCode';
import type { ImportedMcpServer } from './import/readers/common';

// mcp:import-claude 的实现。界面已改用「从本机导入」（mcp:scan-imports / mcp:import），这个通道保留给旧调用方：
// 一次导入 Claude Code 的全部服务器，逐个文件报告状态。解析与「从本机导入」共用 import/readers/claudeCode.ts。

/** 依次读取 Claude 的两个配置文件；单个文件缺失或损坏只体现在它自己的 status 上。 */
export async function importClaudeMcp(options: {
  home: string;
}): Promise<{ servers: ImportedMcpServer[]; sources: McpImportSource[] }> {
  const servers: ImportedMcpServer[] = [];
  const sources: McpImportSource[] = [];
  const files = locateMcpSources({ home: options.home, env: {}, platform: process.platform })[
    'claude-code'
  ];
  for (const file of files) {
    try {
      const text = await readTextIfExists(file);
      if (text === null) {
        sources.push({ file, status: 'not-found', count: 0 });
        continue;
      }
      const parsed = parseJsonc(text);
      const config = parsed.ok ? asRecord(parsed.value) : null;
      // 不带解析器的原始信息：它会引用文件片段，而这个文件里可能有凭证
      if (!config) throw new Error('不是合法的 JSON');
      const found = claudeConfigServers(config);
      servers.push(...found);
      sources.push({ file, status: 'found', count: found.length });
    } catch (error) {
      sources.push({ file, status: 'error', count: 0, error: errorMessage(error) });
    }
  }
  return { servers, sources };
}
