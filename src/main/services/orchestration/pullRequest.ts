// open_pull_request 的纯逻辑：参数校验、推送闸门、PR 正文模板（ARCHITECTURE §6「PR 交付」）。
import { isProtectedPath } from '@fynvra/core';
import { findLocalInfo, type LocalInfoContext, scanSecrets } from '../secrets';

export const PR_TITLE_MAX_CHARS = 200;
export const PR_SUMMARY_MAX_CHARS = 4000;
const PR_BODY_MAX_FILES = 100;

/** 推送闸门要用的本机数据；由 registry 在生产里接线，缺省时 open_pull_request 一律拒绝。 */
export interface PullRequestGateDeps {
  /** 已知密钥值；只用于匹配 */
  knownSecrets(): Promise<readonly string[]>;
  localInfo(): Promise<LocalInfoContext>;
}

const bodyExtensions = new Map<string, (taskId: string) => string | undefined>();

/**
 * 按来源注入 PR 正文附加段（如渠道插件的 note）；undefined 注销该来源。
 * 多个来源按登记顺序拼接，返回 undefined 或空串的不加。
 */
export function setPullRequestBodyExtension(
  source: string,
  extension: ((taskId: string) => string | undefined) | undefined
): void {
  if (extension) bodyExtensions.set(source, extension);
  else bodyExtensions.delete(source);
}

/** 合法分支名：不含空白与控制字符、`..`、git 禁用字符，不以 `-` 或 `/` 开头。 */
export function isValidBranchName(name: string): boolean {
  return (
    name !== '' &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
    !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name) &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !/^[-/]/.test(name) &&
    !/(\/|\.|\.lock)$/.test(name)
  );
}

/** title / summary / base 的校验；返回错误文本或 null。 */
export function pullRequestInputError(input: {
  title?: unknown;
  summary?: unknown;
  base?: unknown;
  draft?: unknown;
}): string | null {
  const { title, summary, base, draft } = input;
  if (typeof title !== 'string' || title.trim() === '') return 'title is required';
  if (title.length > PR_TITLE_MAX_CHARS)
    return `title must be at most ${PR_TITLE_MAX_CHARS} characters`;
  if (/[\r\n]/.test(title)) return 'title must be a single line';
  if (typeof summary !== 'string' || summary.trim() === '') return 'summary is required';
  if (summary.length > PR_SUMMARY_MAX_CHARS) {
    return `summary must be at most ${PR_SUMMARY_MAX_CHARS} characters`;
  }
  if (base !== undefined && (typeof base !== 'string' || !isValidBranchName(base))) {
    return 'base must be a valid branch name';
  }
  if (draft !== undefined && typeof draft !== 'boolean') return 'draft must be a boolean';
  return null;
}

export const PR_BODY_CI_NOTE =
  '- 单元测试与构建未在本机运行，由 PR 的 Checks（CI）负责，合并前请查看 Checks 结果';
/** 值班任务经维护者批准在本机跑过 `pnpm test` 时的说明 */
export const PR_BODY_BUILD_CI_NOTE = '- 构建由 PR 的 Checks（CI）负责，合并前请查看 Checks 结果';

export function buildPullRequestBody(input: {
  taskId: string;
  summary: string;
  files: readonly string[];
  checks: readonly string[];
  /** 受限协调者（值班）派出的任务：本机只跑 typecheck / lint（维护者批准时加 pnpm test），其余交给 PR 的 Checks。 */
  restricted?: boolean;
}): string {
  const { files, checks } = input;
  const verified = checks.map((command) => `- \`${command}\``);
  if (input.restricted) {
    verified.push(checks.includes('pnpm test') ? PR_BODY_BUILD_CI_NOTE : PR_BODY_CI_NOTE);
  }
  const listed = files.slice(0, PR_BODY_MAX_FILES).map((file) => `- \`${file}\``);
  if (files.length > PR_BODY_MAX_FILES) listed.push(`…另有 ${files.length - PR_BODY_MAX_FILES} 个`);
  const sections = [
    `## 改动\n\n${input.summary.trim()}`,
    `## 文件\n\n${listed.length > 0 ? listed.join('\n') : '（无）'}`,
    `## 验证\n\n${verified.length > 0 ? verified.join('\n') : '见 CI'}`,
  ];
  for (const extension of bodyExtensions.values()) {
    const text = extension(input.taskId)?.trim();
    if (text) sections.push(text);
  }
  return `${sections.join('\n\n')}\n`;
}

/** `git diff --raw -z` 里新 mode 为符号链接（120000）或子模块（160000）的路径。 */
export function linkOrSubmodulePaths(raw: string): string[] {
  const parts = raw.split('\0');
  const found: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const meta = parts[index] ?? '';
    if (!meta.startsWith(':')) continue;
    const newMode = meta.slice(1).split(' ')[1];
    const path = parts[index + 1] ?? '';
    if (newMode === '120000' || newMode === '160000') found.push(path);
    index += 1;
  }
  return found;
}

/**
 * 推送闸门：任一命中就返回拒绝原因（只列文件名与类别，不含命中的值）；通过返回 null。
 * 受限任务另查保护路径与符号链接 / 子模块；所有任务查密钥与本机路径、主机名（不查单独的用户名单词，误报太多）。
 */
export function pushGateError(input: {
  restricted: boolean;
  files: readonly string[];
  links: readonly string[];
  text: string;
  known: readonly string[];
  local: LocalInfoContext;
}): string | null {
  if (input.restricted) {
    const protectedFiles = input.files.filter((file) => isProtectedPath(file));
    if (protectedFiles.length > 0) {
      return `refusing to push: the change touches protected paths (${protectedFiles.join(', ')}); a maintainer must handle these files`;
    }
    if (input.links.length > 0) {
      return `refusing to push: the change adds symlinks or submodules (${input.links.join(', ')}); a maintainer must handle these entries`;
    }
  }
  const secrets = scanSecrets(input.text, input.known);
  if (secrets.hit) {
    return `refusing to push: the diff, commit messages or PR text contain possible secrets (${secrets.kinds.join(', ')}); remove them from the branch history first`;
  }
  const local = findLocalInfo(input.text, { ...input.local, userName: undefined });
  if (local.hit) {
    return `refusing to push: the diff, commit messages or PR text contain local machine info (${local.kinds.join(', ')}); remove it first`;
  }
  return null;
}

/** `gh pr create` 输出里的 PR 链接（最后一个 https 链接）。 */
export function pullRequestUrlOf(output: string): string | undefined {
  return output.match(/https:\/\/\S+/g)?.at(-1);
}
