import type { McpServerEntry, McpServerEntryView } from '@shared/types/llm';
import type { McpUpsertInput, SecretFieldInput } from '../../../preload/domains/mcp';
import { translate } from '../../i18n';

// MCP 服务器表单的纯逻辑（不碰 DOM，可在 node 下测试）。

/** env / headers 编辑器的一行。 */
export interface SecretRow {
  /** React key，不提交 */
  rowId: number;
  key: string;
  value: string;
  /** Main 里已有这个键的值（界面拿不到明文）：value 留空表示沿用，键名不可改 */
  saved: boolean;
}

export interface McpDraft {
  /** 编辑已有服务器时的 id；新建时缺省 */
  id?: string;
  name: string;
  transport: McpServerEntry['transport'];
  command: string;
  /** 一行一个参数 */
  argsText: string;
  url: string;
  enabled: boolean;
  env: SecretRow[];
  headers: SecretRow[];
}

type FormResult<T> = ({ ok: true } & T) | { ok: false; error: string };

let nextRowId = 1;

export function addSecretRow(
  rows: readonly SecretRow[],
  key = '',
  value = '',
  saved = false
): SecretRow[] {
  const row: SecretRow = { rowId: nextRowId, key, value, saved };
  nextRowId += 1;
  return [...rows, row];
}

export function emptyMcpDraft(): McpDraft {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    url: '',
    enabled: true,
    env: [],
    headers: [],
  };
}

export function draftFromServer(server: McpServerEntryView): McpDraft {
  const savedRows = (keys: readonly string[]) =>
    keys.reduce<SecretRow[]>((rows, key) => addSecretRow(rows, key, '', true), []);
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    argsText: (server.args ?? []).join('\n'),
    url: server.url ?? '',
    enabled: server.enabled,
    env: savedRows(server.envKeys),
    headers: savedRows(server.headerKeys),
  };
}

/**
 * 表单 → mcp:upsert 入参。编辑时总是提交完整的 env / headers 键集合（删掉的行即删除该键）；
 * 新建且没有任何行时不提交。
 */
export function draftToMcpInput(draft: McpDraft): FormResult<{ input: McpUpsertInput }> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: translate('settings.providers.nameRequired') };
  const common = { ...(draft.id ? { id: draft.id } : {}), name };
  const includeFields = (fields: SecretFieldInput[]) => fields.length > 0 || draft.id !== undefined;

  if (draft.transport === 'stdio') {
    const command = draft.command.trim();
    if (!command) return { ok: false, error: translate('settings.mcp.commandRequired') };
    const args = draft.argsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const env = rowsToFields(draft.env, translate('settings.mcp.env'));
    if (typeof env === 'string') return { ok: false, error: env };
    return {
      ok: true,
      input: {
        ...common,
        transport: 'stdio',
        command,
        ...(args.length > 0 ? { args } : {}),
        enabled: draft.enabled,
        ...(includeFields(env) ? { env } : {}),
      },
    };
  }

  const url = draft.url.trim();
  if (!url) return { ok: false, error: translate('settings.mcp.urlRequired') };
  const headers = rowsToFields(draft.headers, translate('settings.mcp.header'));
  if (typeof headers === 'string') return { ok: false, error: headers };
  return {
    ok: true,
    input: {
      ...common,
      transport: draft.transport,
      url,
      enabled: draft.enabled,
      ...(includeFields(headers) ? { headers } : {}),
    },
  };
}

/** 行 → SecretFieldInput；返回字符串表示错误。完全空白的新行忽略。 */
function rowsToFields(rows: readonly SecretRow[], label: string): SecretFieldInput[] | string {
  const fields: SecretFieldInput[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value && !row.saved) continue;
    if (!key) return translate('settings.mcp.keyEmpty', { label });
    if (/\s/.test(key)) return translate('settings.mcp.keyWhitespace', { label, key });
    if (seen.has(key)) return translate('settings.mcp.keyDuplicate', { label, key });
    seen.add(key);
    if (row.value !== '') fields.push({ key, value: row.value });
    else if (row.saved) fields.push({ key });
    else return translate('settings.mcp.valueRequired', { label, key });
  }
  return fields;
}
