import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { app, ipcMain } from 'electron';
import type { McpImportResult, McpListResult, McpSaveResult } from '../../preload/domains/mcp';
import { importClaudeMcp } from '../services/mcp/claudeImport';
import { createMcpRegistry, type McpRegistry, toMcpServerView } from '../services/mcp/mcpRegistry';
import { parseMcpUpsert } from '../services/mcp/parseMcpInput';
import { isRegistryId } from '../services/providers/jsonRegistry';
import { sendToAllWindows } from '../windows/createAppWindow';

let registry: McpRegistry | null = null;

/** Main 唯一的 mcp.json 句柄（含 env / headers 明文）；会话按角色的 mcpServerIds 取配置也走这里。 */
export function getMcpRegistry(): McpRegistry {
  registry ??= createMcpRegistry({ filePath: join(app.getPath('userData'), 'mcp.json') });
  return registry;
}

export function registerMcpHandlers(): void {
  // 返回给 Renderer 的一律是 toMcpServerView：env / headers 只有键名
  ipcMain.handle(IPC_CHANNELS.MCP_LIST, async (): Promise<McpListResult> => {
    try {
      return { ok: true, servers: (await getMcpRegistry().list()).map(toMcpServerView) };
    } catch (error) {
      return { ok: false, error: `读取 MCP 服务器失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_UPSERT, async (_event, raw: unknown): Promise<McpSaveResult> => {
    const parsed = parseMcpUpsert(raw);
    if (!parsed.ok) return parsed;
    try {
      const result = await getMcpRegistry().upsert(parsed.input);
      if (!result.ok) return result;
      sendToAllWindows(IPC_CHANNELS.MCP_CHANGED);
      return { ok: true, server: toMcpServerView(result.server) };
    } catch (error) {
      return { ok: false, error: `保存 MCP 服务器失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE, async (_event, rawId: unknown): Promise<IpcResult> => {
    if (!isRegistryId(rawId)) return { ok: false, error: '无效的 MCP 服务器 id' };
    try {
      const removed = await getMcpRegistry().remove(rawId);
      if (!removed) return { ok: false, error: 'MCP 服务器不存在' };
      sendToAllWindows(IPC_CHANNELS.MCP_CHANGED);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `删除 MCP 服务器失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(IPC_CHANNELS.MCP_TOGGLE, async (_event, raw: unknown): Promise<McpSaveResult> => {
    const input = parseToggle(raw);
    if (!input) return { ok: false, error: '无效的参数' };
    try {
      const server = await getMcpRegistry().setEnabled(input.id, input.enabled);
      if (!server) return { ok: false, error: 'MCP 服务器不存在' };
      sendToAllWindows(IPC_CHANNELS.MCP_CHANGED);
      return { ok: true, server: toMcpServerView(server) };
    } catch (error) {
      return { ok: false, error: `更新 MCP 服务器失败：${errorMessage(error)}` };
    }
  });

  // 不接收参数：读哪两个文件由 Main 决定
  ipcMain.handle(IPC_CHANNELS.MCP_IMPORT_CLAUDE, async (): Promise<McpImportResult> => {
    try {
      const { servers, sources } = await importClaudeMcp({ home: homedir() });
      const { added, skipped } = await getMcpRegistry().addMany(servers);
      if (added.length > 0) sendToAllWindows(IPC_CHANNELS.MCP_CHANGED);
      return { ok: true, added: added.map(toMcpServerView), skipped, sources };
    } catch (error) {
      return { ok: false, error: `导入失败：${errorMessage(error)}` };
    }
  });
}

function parseToggle(raw: unknown): { id: string; enabled: boolean } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'id' && key !== 'enabled')) return null;
  const { id, enabled } = record;
  return isRegistryId(id) && typeof enabled === 'boolean' ? { id, enabled } : null;
}
