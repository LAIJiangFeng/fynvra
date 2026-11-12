import { type Static, StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ConfigHost } from '../host';
import { asRecord, compact, pick, stringList, trimmed } from './args';
import { errorResult, fence, safely, textResult } from './result';

export const CONFIG_TOOL_NAME = 'fynvra_config';

export const CONFIG_ACTIONS = [
  'list',
  'skill_install',
  'role_set_skills',
  'mcp_upsert',
  'mcp_remove',
  'workflow_upsert',
  'workflow_remove',
  'plugin_install',
  'plugin_enable',
  'plugin_disable',
] as const;
export type ConfigAction = (typeof CONFIG_ACTIONS)[number];

const objectParam = (description: string) =>
  Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description }));
const listParam = (description: string) =>
  Type.Optional(Type.Array(Type.String(), { description }));

const configSchema = Type.Object(
  {
    action: StringEnum(CONFIG_ACTIONS, {
      description: 'What to do. Every action except list changes Fynvra settings.',
    }),
    id: Type.Optional(
      Type.String({
        description:
          'Target id (from list) for mcp_remove, workflow_remove, plugin_enable and plugin_disable.',
      })
    ),
    source: Type.Optional(
      Type.String({
        description:
          'skill_install: absolute local directory or git/GitHub URL (a github.com/.../tree/<ref>/<dir> URL works). ' +
          'plugin_install: absolute local path, npm:<package>, git:<repo> or an https git URL.',
      })
    ),
    path: Type.Optional(
      Type.String({
        description: 'skill_install: sub-directory inside source that holds SKILL.md.',
      })
    ),
    roles: listParam('skill_install: role ids to add the installed skill to.'),
    role: Type.Optional(Type.String({ description: 'role_set_skills: the role id.' })),
    add: listParam('role_set_skills: skill ids to add.'),
    remove: listParam('role_set_skills: skill ids to remove.'),
    server: objectParam(
      'mcp_upsert: { id? (omit to add, set to replace), name, transport: "stdio"|"sse"|"http", command?, args?, url?, enabled?, ' +
        'env?: { KEY: value }, headers?: { KEY: value } }. Omit a value ({ "key": "KEY" } in list form) to keep the stored one.'
    ),
    workflow: objectParam(
      'workflow_upsert: { id, name, description?, maxRounds?, steps: [{ id, name, roleId, instructions, needs: [stepId...], onFail? }] }; ' +
        'an existing id is replaced.'
    ),
  },
  { additionalProperties: false }
);

/**
 * fynvra_config：经 Main 的配置宿主改 Fynvra 自己的设置（与「设置」页走同一套服务）。
 * list 只读；其余动作由审批门按会话档位审批（见 approval/policy）。
 */
export function createConfigTool(host: ConfigHost): ToolDefinition {
  return defineTool({
    name: CONFIG_TOOL_NAME,
    label: 'Fynvra config',
    description:
      "Configure Fynvra itself when the user asks: list or change skills, MCP servers, workflows, plugins and roles' skills. " +
      'Changes go through Fynvra settings (never edit Fynvra userData files by hand). Secret values are never shown back.',
    promptSnippet:
      'Install skills, edit MCP servers, workflows, plugins and role skills in Fynvra when the user asks',
    parameters: configSchema,
    executionMode: 'sequential',
    prepareArguments: (raw) => normalizeConfigArgs(raw) as Static<typeof configSchema>,
    execute: (_toolCallId, params, signal) =>
      safely(CONFIG_TOOL_NAME, async () => {
        const args = normalizeConfigArgs(params);
        if (!isConfigAction(args.action)) {
          return errorResult(
            CONFIG_TOOL_NAME,
            `action must be one of ${CONFIG_ACTIONS.join(', ')}`
          );
        }
        const result = await host.configure(args, signal);
        if (!result.ok) return errorResult(CONFIG_TOOL_NAME, result.error);
        return textResult(
          `## ${CONFIG_TOOL_NAME} ${args.action}\n${fence(JSON.stringify(result.result ?? null, null, 2), 'json')}`
        );
      }),
  });
}

export function isConfigAction(value: unknown): value is ConfigAction {
  return typeof value === 'string' && (CONFIG_ACTIONS as readonly string[]).includes(value);
}

/** 会改设置的调用（list 以外，含认不出的 action：fail-closed） */
export function isConfigMutation(input: unknown): boolean {
  return asRecord(input).action !== 'list';
}

/** 审批条上的一句话：说清会改什么；只写名字与键名，不带 env / headers 的值 */
export function describeConfigAction(input: unknown): string {
  const args = asRecord(input);
  const text = (value: unknown) => (typeof value === 'string' ? value : '?');
  const list = (value: unknown) =>
    Array.isArray(value) && value.length > 0 ? value.map(String).join(', ') : '';
  switch (args.action) {
    case 'list':
      return 'List Fynvra configuration';
    case 'skill_install': {
      const where = args.path ? ` (${text(args.path)})` : '';
      const roles = list(args.roles);
      return `Install skill from ${text(args.source)}${where}${roles ? ` and add it to role(s) ${roles}` : ''}`;
    }
    case 'role_set_skills': {
      const add = list(args.add);
      const remove = list(args.remove);
      return `Change skills of role ${text(args.role)}:${add ? ` add ${add}` : ''}${remove ? ` remove ${remove}` : ''}`;
    }
    case 'mcp_upsert': {
      const server = asRecord(args.server);
      const target =
        server.url ??
        [server.command, ...(Array.isArray(server.args) ? server.args : [])].join(' ');
      const keys = (value: unknown) =>
        Array.isArray(value)
          ? value.map((field) => String(asRecord(field).key)).join(', ')
          : Object.keys(asRecord(value)).join(', ');
      const env = keys(server.env);
      const headers = keys(server.headers);
      return [
        `${server.id ? `Replace MCP server ${text(server.id)}` : 'Add MCP server'} "${text(server.name)}" (${text(server.transport)}: ${String(target).trim()})`,
        env ? `env keys: ${env}` : '',
        headers ? `header keys: ${headers}` : '',
      ]
        .filter(Boolean)
        .join('; ');
    }
    case 'mcp_remove':
      return `Remove MCP server ${text(args.id)}`;
    case 'workflow_upsert': {
      const workflow = asRecord(args.workflow);
      const steps = Array.isArray(workflow.steps) ? workflow.steps.length : 0;
      return `Save workflow ${text(workflow.id)} "${text(workflow.name)}" (${steps} steps)`;
    }
    case 'workflow_remove':
      return `Remove workflow ${text(args.id)}`;
    case 'plugin_install':
      return `Install plugin from ${text(args.source)}`;
    case 'plugin_enable':
      return `Enable plugin ${text(args.id)}`;
    case 'plugin_disable':
      return `Disable plugin ${text(args.id)}`;
    default:
      return `Unknown Fynvra configuration action ${text(args.action)}`;
  }
}

function normalizeConfigArgs(raw: unknown) {
  const args = asRecord(raw);
  const action = trimmed(pick(args, 'action'));
  return compact({
    action: typeof action === 'string' ? action.toLowerCase() : action,
    id: trimmed(pick(args, 'id')),
    source: trimmed(pick(args, 'source')),
    path: trimmed(pick(args, 'path')),
    roles: stringList(pick(args, 'roles', 'role_ids', 'roleIds')),
    role: trimmed(pick(args, 'role', 'role_id', 'roleId')),
    add: stringList(pick(args, 'add')),
    remove: stringList(pick(args, 'remove')),
    server: pick(args, 'server'),
    workflow: pick(args, 'workflow'),
  });
}
