import type { DirectoryRequest, DirectoryResult, WorkspaceFileEntry } from '@shared/types/files';
import { describe, expect, it, vi } from 'vitest';
import { createFilesApi } from '../../preload/domains/files';
import { createFilesStore } from '../stores/files';
import {
  type ChatFileContext,
  ChatFileLinkError,
  chatFileParts,
  chatFilePath,
  externalChatLink,
  openChatFileLink,
  resolveChatFile,
} from './chatFileLinks';

const context: ChatFileContext = { id: 'session', workspaceId: 'ws', cwd: 'C:/repo' };
const parts = (reference: string, cwd = context.cwd, root = 'C:/repo') =>
  chatFileParts(root, { ...context, cwd }, chatFilePath(reference)).parts;

function fixture(root = 'C:/repo') {
  const entry = (
    id: string,
    name: string,
    kind: WorkspaceFileEntry['kind'] = 'file'
  ): WorkspaceFileEntry => ({
    id,
    name,
    kind,
    relativePath: name,
  });
  const note = entry('note-id', '平台与商户功能手工测试清单.md');
  const html = entry('html-id', '预览 页面.HTML');
  const directories: Record<string, WorkspaceFileEntry[]> = {
    root: [entry('docs-id', 'docs', 'directory'), note, html, entry('run-id', 'run.exe')],
    'docs-id': [entry('nested-id', 'readme.md'), entry('link-id', 'linked.md', 'symlink')],
  };
  const api = {
    ...createFilesApi({ invoke: vi.fn() }),
    list: vi.fn(
      async ({ directoryId }: DirectoryRequest): Promise<DirectoryResult> => ({
        ok: true,
        entries: directories[directoryId ?? 'root'] ?? [],
        truncated: false,
      })
    ),
    resolve: vi.fn(async () => ({ ok: true as const, path: `${root}/docs` })),
    openHtml: vi.fn(async () => ({ ok: true as const })),
    read: vi.fn(async () => ({
      ok: true as const,
      preview: { kind: 'text' as const, text: 'disk', version: 'a'.repeat(64), size: 4 },
    })),
  };
  return { api, note, html };
}

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(ChatFileLinkError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('聊天文件链接路径', () => {
  it.each([
    ['docs/readme.md', ['docs', 'readme.md']],
    ['./docs/../平台与商户功能手工测试清单.md', ['平台与商户功能手工测试清单.md']],
    ['C:/repo/docs/readme.md:12:3', ['docs', 'readme.md']],
    ['C:\\repo\\docs\\readme.md:12', ['docs', 'readme.md']],
    ['file:///C:/repo/%E5%B9%B3%E5%8F%B0%20%E6%B8%85%E5%8D%95.md', ['平台 清单.md']],
    ['file://localhost/C:/repo/docs/readme.md', ['docs', 'readme.md']],
    ['file:///C%3A/repo/docs/readme.md', ['docs', 'readme.md']],
    ['c:/REPO/docs/readme.md', ['docs', 'readme.md']],
    ['docs/with%20spaces.md:12', ['docs', 'with spaces.md']],
    ['docs/a%23b.md', ['docs', 'a#b.md']],
    ['docs/a%253Ab.md', ['docs', 'a%3Ab.md']],
  ])('规范化 %s', (reference, expected) => {
    expect(parts(reference)).toEqual(expected);
  });

  it('相对路径以消息会话 cwd 为准，支持 POSIX 与 cwd 子目录的上级引用', () => {
    expect(parts('../readme.md', 'C:/repo/docs')).toEqual(['readme.md']);
    expect(parts('readme.md', '/home/test/repo/docs', '/home/test/repo')).toEqual([
      'docs',
      'readme.md',
    ]);
    expect(parts('/home/test/repo/清单.md:8:2', '/home/test/repo', '/home/test/repo')).toEqual([
      '清单.md',
    ]);
    expect(
      parts('file:///home/test/repo/%E6%B8%85%E5%8D%95.md', '/home/test/repo', '/home/test/repo')
    ).toEqual(['清单.md']);
    expectCode(
      () => parts('/home/Test/repo/note.md', '/home/test/repo', '/home/test/repo'),
      'outsideWorkspace'
    );
  });

  it.each([
    '',
    '#section',
    'javascript:alert(1)',
    'javascript:1',
    'data:text/html,test',
    'vbscript:1',
    'vscode://file/C:/repo/a.ts',
    'custom:123',
    'https://example.test/a.md',
    'C:relative.md',
    '//server/share/a.md',
    '\\\\server\\share\\a.md',
    'file://server/share/a.md',
    'file:///C:/repo/a.md%00',
    'C:/repo/a%0Ab.md',
    'docs/%zz.md',
    'docs/a.md:other',
    'docs/evil.exe:stream',
    '%6Aavascript%3A1',
    ' note.md',
    '~/.ssh/id_rsa',
  ])('拒绝非法或非文件协议 %s', (reference) => {
    expectCode(() => chatFilePath(reference), 'invalidLink');
  });

  it.each(['page.html?script=javascript:1', 'page.html#section', 'file:///C:/repo/page.html?x=1'])(
    '不将网页参数混入文件路径：%s',
    (reference) => {
      expectCode(() => chatFilePath(reference), 'unsupportedParameters');
    }
  );

  it.each(['../outside.md', '%2e%2e/outside.md', 'C:/repo-other/note.md', 'D:/repo/note.md'])(
    '拒绝越界 %s',
    (reference) => {
      expectCode(() => parts(reference), 'outsideWorkspace');
    }
  );

  it('外部 worker worktree 不回退主 workspace 同名路径；明确原 workspace 绝对链接仍可解析', () => {
    const worker = { ...context, cwd: 'C:/workers/task', worktreeId: 'worker' };
    for (const reference of ['note.md', 'C:/workers/task/note.md'])
      expectCode(
        () => chatFileParts('C:/repo', worker, chatFilePath(reference)),
        'unsupportedRoot'
      );
    expect(chatFileParts('C:/repo', worker, 'C:/repo/note.md').parts).toEqual(['note.md']);
  });

  it('http(s) 只作为外部链接，纯锚点及本地引用从不成为 DOM href', () => {
    expect(externalChatLink('https://example.test/a?q=1#b')).toBe('https://example.test/a?q=1#b');
    expect(externalChatLink('HTTP://example.test')).toBe('http://example.test/');
    for (const value of [
      'javascript:1',
      '//example.test',
      '#x',
      'file:///C:/repo/a.md',
      'note.md',
      'https://a\nb.test',
    ])
      expect(externalChatLink(value)).toBeNull();
  });
});

describe('聊天链接按签发 id 解析与打开', () => {
  it('逐层匹配名称，仅用所属 workspace 和签发 id 请求，不依赖 displayPath 或当前选择', async () => {
    const { api } = fixture('/home/test/repo');
    const original = { ...context, cwd: '/home/test/repo/docs' };
    expect(await resolveChatFile(api, original, './readme.md:12')).toMatchObject({
      id: 'nested-id',
    });
    expect(api.list.mock.calls).toEqual([
      [{ workspaceId: 'ws' }],
      [{ workspaceId: 'ws', directoryId: 'docs-id' }],
    ]);
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws', entryId: 'docs-id' });
  });

  it('点击在途切换工作区后，继续请求和打开仍绑定消息原 workspace', async () => {
    const { api, note } = fixture();
    let finish!: (result: DirectoryResult) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    let selectedWorkspace = 'ws';
    const openFile = vi.fn(async (workspaceId: string) => {
      selectedWorkspace = workspaceId;
    });
    const pending = openChatFileLink(api, context, note.name, openFile);
    selectedWorkspace = 'another-workspace';
    finish({ ok: true, entries: [note], truncated: false });
    api.resolve.mockResolvedValueOnce({ ok: true, path: `C:/repo/${note.name}` });
    await pending;
    expect(selectedWorkspace).toBe('ws');
    expect(api.list).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws' });
    expect(api.resolve).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws', entryId: note.id });
    expect(openFile).toHaveBeenCalledExactlyOnceWith('ws', note);
  });

  it('HTML 只走受限 Main API，普通文件（包括可执行扩展名）只打开 tab', async () => {
    const { api, note, html } = fixture();
    const openFile = vi.fn(async () => undefined);
    await openChatFileLink(api, context, encodeURI(note.name), openFile);
    expect(openFile).toHaveBeenCalledExactlyOnceWith('ws', note);
    await openChatFileLink(api, context, encodeURI(html.name), openFile);
    expect(api.openHtml).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'ws', entryId: html.id });
    expect(openFile).toHaveBeenCalledTimes(1);
    await openChatFileLink(api, context, 'run.exe', openFile);
    expect(openFile.mock.calls.at(-1)).toEqual(['ws', expect.objectContaining({ id: 'run-id' })]);
    expect(api.openHtml).toHaveBeenCalledTimes(1);
  });

  it('复用文件 store 打开已编辑 Markdown 不覆盖草稿，仍选中该 tab 并保留预览模式', async () => {
    const { api, note } = fixture();
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(note);
    store.getState().editFile(note.id, 'unsaved draft');
    store.getState().showChat();
    await openChatFileLink(api, context, note.name, async (workspaceId, entry) => {
      expect(workspaceId).toBe('ws');
      await store.getState().openFile(entry);
    });
    expect(store.getState().selectedId).toBe(note.id);
    expect(store.getState().previews[note.id]).toMatchObject({
      draft: 'unsaved draft',
      mode: 'preview',
    });
    expect(api.read).toHaveBeenCalledTimes(1);
  });

  it('缺失、符号链接、超大目录和 worktree 的错误明确返回，不尝试打开同名旧文件', async () => {
    const { api, note } = fixture();
    for (const [reference, code] of [
      ['missing.md', 'entryNotFound'],
      ['docs/linked.md', 'notFile'],
    ] as const)
      await expect(resolveChatFile(api, context, reference)).rejects.toMatchObject({ code });
    await expect(
      resolveChatFile(api, { ...context, cwd: 'C:/workers/task', worktreeId: 'w' }, note.name)
    ).rejects.toMatchObject({ code: 'unsupportedRoot' });
    api.list.mockResolvedValueOnce({ ok: true, entries: [note], truncated: true });
    api.resolve.mockResolvedValueOnce({ ok: true, path: `C:/repo/${note.name}` });
    await expect(resolveChatFile(api, context, 'missing.md')).rejects.toMatchObject({
      code: 'truncated',
    });
    expect(api.openHtml).not.toHaveBeenCalled();
  });

  it('取消后的迟到解析不打开 tab 或浏览器，非法链接完全不访问文件 API', async () => {
    const { api, html } = fixture();
    const openFile = vi.fn(async () => undefined);
    await openChatFileLink(api, context, html.name, openFile, () => false);
    expect(api.openHtml).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    api.list.mockClear();
    await expect(openChatFileLink(api, context, 'javascript:1', openFile)).rejects.toMatchObject({
      code: 'invalidLink',
    });
    expect(api.list).not.toHaveBeenCalled();
  });
});
