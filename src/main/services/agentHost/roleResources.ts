import type { Role } from '@fynvra/core';
import type { AgentMcpServer } from '@shared/types/agent';
import type { McpRegistry, StoredMcpServer } from '../mcp/mcpRegistry';
import type { SkillRegistry } from '../skills/skillRegistry';
import type { RoleResources } from './agentHost';

export interface RoleResourceSources {
  skills: Pick<SkillRegistry, 'list'>;
  /** 含 env / headers 明文：解析结果只交给 worker（spawn-session 这一跳），不经 IPC */
  mcpServers: Pick<McpRegistry, 'list'>;
}

/**
 * agentHost 的 `resolveResources`：按角色的 skillIds / mcpServerIds 从 skills.json、mcp.json 取条目。
 * - 技能取目录路径，MCP 服务器以注册表 id 为名映射成协议里的 AgentMcpServer（stdio 带 command / args / env，
 *   http / sse 带 url / headers；worker 再补上 pi 的传输类型）；
 * - 停用的条目不加载；角色引用了已删除的 id 时跳过，记一条 warning；
 * - 每次调用都重读注册表（它们有内存缓存），设置页的修改对之后启动的会话生效。
 */
export function createRoleResourceResolver(
  sources: RoleResourceSources
): (role: Role) => Promise<RoleResources> {
  return async (role) => {
    const skillIds = [...new Set(role.skillIds)];
    const serverIds = [...new Set(role.mcpServerIds)];
    const [skills, servers] = await Promise.all([
      skillIds.length > 0 ? sources.skills.list() : [],
      serverIds.length > 0 ? sources.mcpServers.list() : [],
    ]);
    const warnings: string[] = [];

    const skillPaths = skillIds.flatMap((id) => {
      const skill = skills.find((candidate) => candidate.id === id);
      if (!skill) {
        warnings.push(`skill "${id}" of role "${role.id}" is no longer registered; skipped`);
      }
      return skill?.enabled ? [skill.path] : [];
    });
    const mcpServers = serverIds.flatMap((id) => {
      const server = servers.find((candidate) => candidate.id === id);
      if (!server) {
        warnings.push(`MCP server "${id}" of role "${role.id}" is no longer registered; skipped`);
      }
      return server?.enabled ? [toAgentMcpServer(server)] : [];
    });
    return { skills: skillPaths, mcpServers, warnings };
  };
}

function toAgentMcpServer(server: StoredMcpServer): AgentMcpServer {
  if (server.transport === 'stdio') {
    return {
      name: server.id,
      command: server.command ?? '',
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return {
    name: server.id,
    url: server.url ?? '',
    ...(server.headers ? { headers: server.headers } : {}),
  };
}
