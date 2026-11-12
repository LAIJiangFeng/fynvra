import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  isValidRoleId,
  isValidWorkflowId,
  parseRole,
  parseWorkflow,
  type Role,
  type RoleStore,
} from '@fynvra/core';
import { asRecord, errorMessage } from '@shared/guards';
import type { HostCallResult } from '@shared/types/agent';
import { IPC_CHANNELS } from '@shared/types/ipc';
import type { PluginEntry } from '@shared/types/plugins';
import type { PluginAddResult, PluginToggleResult } from '../../../preload/domains/plugins';
import { savedCommandEnvironment } from '../commandNetwork';
import { type McpRegistry, toMcpServerView } from '../mcp/mcpRegistry';
import { parseMcpUpsert } from '../mcp/parseMcpInput';
import { isRegistryId } from '../providers/jsonRegistry';
import { readSkillManifest } from '../skills/skillManifest';
import type { SkillRegistry } from '../skills/skillRegistry';
import type { WorkflowRegistry } from '../workflows/workflowRegistry';

export type CloneResult = { ok: true } | { ok: false; error: string };
export type GitCloner = (
  url: string,
  ref: string | undefined,
  dest: string,
  signal: AbortSignal
) => Promise<CloneResult>;

/** 与「设置」页 IPC handler 用的是同一批服务实例（生产由 ipc/sessions.ts 注入） */
export interface ConfigHostDeps {
  skills: Pick<SkillRegistry, 'list' | 'add'>;
  roles: Pick<RoleStore, 'list' | 'get' | 'save'>;
  mcp: Pick<McpRegistry, 'list' | 'get' | 'upsert' | 'remove'>;
  workflows: Pick<WorkflowRegistry, 'list' | 'save' | 'remove'>;
  plugins: {
    list(): Promise<PluginEntry[]>;
    /** ipc/plugins.ts 的 installPlugin（已广播） */
    install(source: string): Promise<PluginAddResult>;
    /** ipc/plugins.ts 的 setPluginEnabled（已广播） */
    setEnabled(id: string, enabled: boolean): Promise<PluginToggleResult>;
  };
  broadcast(channel: string): void;
  /** 从 git 安装的技能克隆到这里（userData/skills）；本地目录照「设置」原地登记 */
  skillsDir: string;
  cloneGit?: GitCloner;
}

export interface ConfigHost {
  /** fynvra_config 的 host-invoke（kind: 'config'）；永不抛异常 */
  invoke(method: string, input: unknown, signal: AbortSignal): Promise<HostCallResult>;
}

type Args = Record<string, unknown>;
type Outcome = { ok: true; result: unknown } | { ok: false; error: string };

const fail = (error: string): Outcome => ({ ok: false, error });

/**
 * Main 侧的配置宿主：agent 的 fynvra_config 经它改技能 / MCP / 工作流 / 插件 / 角色技能，
 * 校验与广播与「设置」页的 IPC handler 一致。审批已在 agent 进程的审批门完成；这里只做入参收窄。
 * 结果里 MCP 只给 toMcpServerView（env / headers 只有键名）。
 */
export function createConfigHost(deps: ConfigHostDeps): ConfigHost {
  const cloneGit = deps.cloneGit ?? gitClone;

  async function saveRole(role: Role): Promise<Outcome> {
    const parsed = parseRole(role);
    if (!parsed.ok) return fail(parsed.error);
    const saved = await deps.roles.save(parsed.role);
    if (!saved.ok) return fail(saved.error);
    deps.broadcast(IPC_CHANNELS.ROLES_CHANGED);
    return { ok: true, result: { role: saved.role.id, skillIds: saved.role.skillIds } };
  }

  async function list(): Promise<Outcome> {
    const [skills, servers, workflows, plugins, roles] = await Promise.all([
      deps.skills.list(),
      deps.mcp.list(),
      deps.workflows.list(),
      deps.plugins.list(),
      deps.roles.list(),
    ]);
    return {
      ok: true,
      result: {
        skills: skills.map(({ id, name, enabled, description }) => ({
          id,
          name,
          enabled,
          ...(description ? { description } : {}),
        })),
        mcpServers: servers.map(toMcpServerView),
        workflows: workflows.map((workflow) => ({
          id: workflow.id,
          name: workflow.name,
          ...(workflow.description ? { description: workflow.description } : {}),
          steps: workflow.steps.map(({ id, name, roleId, needs }) => ({ id, name, roleId, needs })),
        })),
        plugins: plugins.map(({ id, name, kind, source, enabled }) => ({
          id,
          name,
          kind,
          source,
          enabled,
        })),
        roles: roles.map((role) => ({
          id: role.id,
          name: role.name,
          tools: role.tools,
          approvalMode: role.approvalMode,
          skillIds: role.skillIds,
          mcpServerIds: role.mcpServerIds,
          pluginIds: role.pluginIds ?? [],
        })),
      },
    };
  }

  async function installSkill(args: Args, signal: AbortSignal): Promise<Outcome> {
    const source = typeof args.source === 'string' ? args.source.trim() : '';
    if (!source) return fail('skill_install needs source (a local directory or a git URL)');
    if (args.path !== undefined && typeof args.path !== 'string') {
      return fail('path must be a string');
    }
    const roleIds = idList(args.roles, isValidRoleId);
    if (!roleIds) return fail('roles must be a list of role ids');
    for (const roleId of roleIds) {
      if (!(await deps.roles.get(roleId))) return fail(`role ${roleId} does not exist`);
    }
    const git = parseGitSource(source);
    if (!git && !isAbsolute(source)) {
      return fail('source must be an absolute directory path or a git/GitHub URL');
    }
    let root = source;
    let cloned: string | undefined;
    let keep = false;
    try {
      if (git) {
        await mkdir(deps.skillsDir, { recursive: true });
        cloned = join(deps.skillsDir, `${git.name}-${randomUUID().slice(0, 8)}`);
        const result = await cloneGit(git.url, git.ref, cloned, signal);
        if (!result.ok) return fail(`git clone failed: ${result.error}`);
        root = cloned;
      }
      const sub = [git?.subdir, args.path as string | undefined].filter(Boolean).join('/');
      const dir = await resolveInside(root, sub);
      if (!dir) return fail(`path ${sub} is outside the skill source`);
      const manifest = await readSkillManifest(dir);
      if (!manifest.ok) return fail(manifest.error);
      const { added, skipped } = await deps.skills.add([{ ...manifest.manifest, path: dir }]);
      const skill = added[0];
      if (!skill) return fail(skipped[0] ?? 'the skill is already registered');
      keep = true;
      deps.broadcast(IPC_CHANNELS.SKILLS_CHANGED);
      const attached: string[] = [];
      for (const roleId of roleIds) {
        const role = await deps.roles.get(roleId);
        if (!role) continue;
        const saved = await saveRole({ ...role, skillIds: [...role.skillIds, skill.id] });
        if (!saved.ok)
          return fail(`skill ${skill.id} was installed, but ${roleId}: ${saved.error}`);
        attached.push(roleId);
      }
      return {
        ok: true,
        result: { skill: { id: skill.id, name: skill.name, path: skill.path }, roles: attached },
      };
    } finally {
      if (cloned && !keep)
        await rm(cloned, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function setRoleSkills(args: Args): Promise<Outcome> {
    if (!isValidRoleId(args.role)) return fail('role_set_skills needs role (a role id)');
    const add = idList(args.add, isRegistryId);
    const remove = idList(args.remove, isRegistryId);
    if (!add || !remove) return fail('add / remove must be lists of skill ids');
    if (add.length === 0 && remove.length === 0) return fail('nothing to add or remove');
    const known = new Set((await deps.skills.list()).map((skill) => skill.id));
    const unknown = add.filter((id) => !known.has(id));
    if (unknown.length > 0)
      return fail(`unknown skill id(s): ${unknown.join(', ')}; call list first`);
    const role = await deps.roles.get(args.role);
    if (!role) return fail(`role ${args.role} does not exist`);
    const skillIds = [...new Set([...role.skillIds.filter((id) => !remove.includes(id)), ...add])];
    return saveRole({ ...role, skillIds });
  }

  async function upsertMcp(args: Args): Promise<Outcome> {
    const server = asRecord(args.server);
    if (!server) return fail('mcp_upsert needs server (an object)');
    const input: Args = { ...server };
    for (const key of ['env', 'headers'] as const) {
      const map = asRecord(input[key]);
      // 模型更常写 { KEY: value }：换成 mcp:upsert 的字段列表；null 表示保留已存的值
      if (map) {
        input[key] = Object.entries(map).map(([field, value]) =>
          value === null ? { key: field } : { key: field, value }
        );
      }
    }
    if (input.enabled === undefined) {
      const existing = isRegistryId(input.id) ? await deps.mcp.get(input.id) : undefined;
      input.enabled = existing?.enabled ?? true;
    }
    const parsed = parseMcpUpsert(input);
    if (!parsed.ok) return parsed;
    const saved = await deps.mcp.upsert(parsed.input);
    if (!saved.ok) return saved;
    deps.broadcast(IPC_CHANNELS.MCP_CHANGED);
    return { ok: true, result: { server: toMcpServerView(saved.server) } };
  }

  async function removeMcp(args: Args): Promise<Outcome> {
    if (!isRegistryId(args.id)) return fail('mcp_remove needs id (an MCP server id)');
    if (!(await deps.mcp.remove(args.id))) return fail(`MCP server ${args.id} does not exist`);
    deps.broadcast(IPC_CHANNELS.MCP_CHANGED);
    return { ok: true, result: { removed: args.id } };
  }

  async function upsertWorkflow(args: Args): Promise<Outcome> {
    const parsed = parseWorkflow(args.workflow);
    if (!parsed.ok) return fail(`invalid workflow: ${parsed.error}`);
    const saved = await deps.workflows.save(parsed.workflow);
    if (!saved.ok) return saved;
    return { ok: true, result: { workflow: { id: saved.workflow.id, name: saved.workflow.name } } };
  }

  async function removeWorkflow(args: Args): Promise<Outcome> {
    if (!isValidWorkflowId(args.id)) return fail('workflow_remove needs id (a workflow id)');
    if (!(await deps.workflows.remove(args.id))) return fail(`workflow ${args.id} does not exist`);
    return { ok: true, result: { removed: args.id } };
  }

  async function installPlugin(args: Args): Promise<Outcome> {
    const source = typeof args.source === 'string' ? args.source.trim() : '';
    if (!source) return fail('plugin_install needs source');
    const result = await deps.plugins.install(source);
    if (!result.ok) return fail(result.error);
    const { id, name, kind, enabled } = result.plugin;
    return { ok: true, result: { plugin: { id, name, kind, enabled } } };
  }

  async function togglePlugin(args: Args, enabled: boolean): Promise<Outcome> {
    if (!isRegistryId(args.id)) return fail('needs id (a plugin id)');
    const result = await deps.plugins.setEnabled(args.id, enabled);
    if (!result.ok) return fail(result.error);
    return {
      ok: true,
      result: { plugin: { id: result.plugin.id, enabled: result.plugin.enabled } },
    };
  }

  async function run(args: Args, signal: AbortSignal): Promise<Outcome> {
    switch (args.action) {
      case 'list':
        return list();
      case 'skill_install':
        return installSkill(args, signal);
      case 'role_set_skills':
        return setRoleSkills(args);
      case 'mcp_upsert':
        return upsertMcp(args);
      case 'mcp_remove':
        return removeMcp(args);
      case 'workflow_upsert':
        return upsertWorkflow(args);
      case 'workflow_remove':
        return removeWorkflow(args);
      case 'plugin_install':
        return installPlugin(args);
      case 'plugin_enable':
        return togglePlugin(args, true);
      case 'plugin_disable':
        return togglePlugin(args, false);
      default:
        return fail(`unknown action: ${String(args.action)}`);
    }
  }

  return {
    async invoke(method, input, signal) {
      if (method !== 'configure') return { ok: false, error: `unknown config method: ${method}` };
      const args = asRecord(input);
      if (!args) return { ok: false, error: 'configure needs an input object' };
      try {
        const outcome = await run(args, signal);
        return outcome.ok ? { ok: true, result: outcome.result } : outcome;
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  };
}

function idList(raw: unknown, valid: (value: unknown) => boolean): string[] | null {
  if (raw === undefined) return [];
  return Array.isArray(raw) && raw.every(valid) ? [...new Set(raw as string[])] : null;
}

const SAFE_REF = /^[\w.][\w./-]*$/;

/**
 * git 来源：https URL、git@host:path（SSH），以及 GitHub 的 `/tree/<ref>/<dir>` 网页地址（拆成仓库 + 分支 + 子目录）。
 * 其他字符串不是 git 来源。
 */
export function parseGitSource(
  source: string
): { url: string; ref?: string; subdir?: string; name: string } | null {
  if (/[\s\0]/.test(source)) return null;
  const tree =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+?))?\/?$/.exec(
      source
    );
  if (tree) {
    const [, owner, repo, ref, subdir] = tree as unknown as [
      string,
      string,
      string,
      string,
      string?,
    ];
    if (!SAFE_REF.test(ref)) return null;
    return {
      url: `https://github.com/${owner}/${repo}.git`,
      ref,
      ...(subdir ? { subdir } : {}),
      name: slug(repo),
    };
  }
  let path: string;
  if (source.startsWith('https://')) {
    try {
      const url = new URL(source);
      if (url.username || url.password || url.pathname.length <= 1) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (/^git@[\w.-]+:[\w./-]+$/.test(source)) {
    path = source.slice(source.indexOf(':') + 1);
  } else {
    return null;
  }
  const last = path.replace(/\/+$/, '').split('/').pop() ?? '';
  return { url: source, name: slug(last.replace(/\.git$/, '')) };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'skill'
  );
}

/** root 下的子目录（解析符号链接后仍在 root 内），否则 null；root 不存在时抛错 */
export async function resolveInside(root: string, sub: string): Promise<string | null> {
  const realRoot = await realpath(root);
  let target: string;
  try {
    target = await realpath(resolve(realRoot, sub || '.'));
  } catch {
    target = resolve(realRoot, sub || '.');
  }
  const rel = relative(realRoot, target);
  if (rel === '') return target;
  return isAbsolute(rel) || rel.split(sep)[0] === '..' ? null : target;
}

/** 与其他命令子进程一样带「设置」里的网络代理 */
const gitClone: GitCloner = (url, ref, dest, signal) =>
  new Promise((done) => {
    execFile(
      'git',
      [
        '-c',
        'core.symlinks=false',
        'clone',
        '--depth',
        '1',
        ...(ref ? ['--branch', ref] : []),
        '--',
        url,
        dest,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        signal,
        env: { ...savedCommandEnvironment(), GIT_TERMINAL_PROMPT: '0' },
      },
      (error, _stdout, stderr) =>
        done(error ? { ok: false, error: stderr.trim() || error.message } : { ok: true })
    );
  });
