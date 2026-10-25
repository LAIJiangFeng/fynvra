import type {
  DirectoryResult,
  FileResult,
  FileWriteResult,
  WorkspaceFileEntry,
} from '@shared/types/files';
import { describe, expect, it, vi } from 'vitest';
import {
  bindFileUnloadGuard,
  createFilesStore,
  filesStoreFor,
  isFileDirty,
  ROOT_DIRECTORY_ID,
} from './files';

const file = (id: string): WorkspaceFileEntry => ({
  id,
  name: `${id}.ts`,
  relativePath: `${id}.ts`,
  kind: 'file',
});
const ready = (
  text: string
): Extract<FileResult, { ok: true }> & { preview: { kind: 'text' } } => ({
  ok: true,
  preview: { kind: 'text', text, size: text.length, version: 'a'.repeat(64) },
});
const fakeApi = () => ({
  list: vi.fn(
    async (): Promise<DirectoryResult> => ({ ok: true, entries: [file('a')], truncated: false })
  ),
  read: vi.fn(async (): Promise<FileResult> => ready('内容')),
  write: vi.fn(
    async ({ text }: { text: string }): Promise<FileWriteResult> => ({
      ok: true,
      preview: { ...ready(text).preview, version: 'b'.repeat(64) },
    })
  ),
});

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('文件预览状态', () => {
  it('超限草稿保留并提示大小限制，不发送无效 IPC', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    const text = '中'.repeat(100000);
    store.getState().editFile('a', text);
    expect(await store.getState().saveFile('a')).toBe(false);
    expect(store.getState().previews.a).toMatchObject({
      draft: text,
      saveError: 'tooLarge',
      saving: false,
    });
    expect(api.write).not.toHaveBeenCalled();
  });
  it('退出保护检查所有工作区的草稿，保存后不再拦截', async () => {
    const store = filesStoreFor('unload-test', fakeApi());
    const target = new EventTarget();
    const unbind = bindFileUnloadGuard(target);
    await store.getState().openFile(file('a'));
    store.getState().editFile('a', '尚未保存');
    store.getState().showChat();
    const dirty = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(dirty, 'returnValue', { value: '', writable: true });
    target.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    await store.getState().saveFile('a');
    const clean = new Event('beforeunload', { cancelable: true });
    target.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    unbind();
    store.getState().closeFile('a');
  });
  it('对话与文件可切换，刷新不会丢失未保存正文', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    store.getState().editFile('a', '草稿');
    store.getState().showChat();
    expect(store.getState().selectedId).toBeNull();
    await store.getState().refresh();
    await store.getState().openFile(file('a'));
    expect(store.getState().previews.a?.draft).toBe('草稿');
    expect(isFileDirty(store.getState().previews.a)).toBe(true);
    expect(api.read).toHaveBeenCalledTimes(1);
  });

  it('未保存文件默认拒绝关闭，明确放弃后才关闭', async () => {
    const store = createFilesStore(fakeApi(), 'ws');
    await store.getState().openFile(file('a'));
    store.getState().editFile('a', '草稿');
    expect(store.getState().closeFile('a')).toBe(false);
    expect(store.getState().opened).toHaveLength(1);
    expect(store.getState().closeFile('a', true)).toBe(true);
    expect(store.getState().opened).toHaveLength(0);
  });

  it('保存传读取版本和草稿，成功后清除未保存状态', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    store.getState().editFile('a', '草稿');
    expect(await store.getState().saveFile('a')).toBe(true);
    expect(api.write).toHaveBeenCalledWith({
      workspaceId: 'ws',
      fileId: 'a',
      version: 'a'.repeat(64),
      text: '草稿',
    });
    expect(isFileDirty(store.getState().previews.a)).toBe(false);
    expect(store.getState().previews.a?.preview).toMatchObject({
      text: '草稿',
      version: 'b'.repeat(64),
    });
  });

  it('保存中继续输入时保留新草稿，禁止关闭和重复保存', async () => {
    const api = fakeApi();
    const pending = deferred<FileWriteResult>();
    api.write.mockReturnValueOnce(pending.promise);
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    store.getState().editFile('a', '保存时');
    const saving = store.getState().saveFile('a');
    store.getState().editFile('a', '保存中的新输入');
    expect(store.getState().closeFile('a', true)).toBe(false);
    expect(await store.getState().saveFile('a')).toBe(false);
    pending.resolve({ ok: true, preview: { ...ready('保存时').preview, version: 'b'.repeat(64) } });
    await saving;
    expect(store.getState().previews.a?.draft).toBe('保存中的新输入');
    expect(isFileDirty(store.getState().previews.a)).toBe(true);
    expect(api.write).toHaveBeenCalledTimes(1);
  });

  it('保存冲突保留草稿，用户明确重新读取才放弃', async () => {
    const api = fakeApi();
    api.write.mockResolvedValue({ ok: false, error: 'conflict' });
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    store.getState().editFile('a', '我的修改');
    expect(await store.getState().saveFile('a')).toBe(false);
    expect(store.getState().previews.a).toMatchObject({ draft: '我的修改', saveError: 'conflict' });
    await store.getState().reloadFile('a');
    expect(store.getState().previews.a?.draft).toBe('我的修改');
    api.read.mockResolvedValue(ready('磁盘新内容'));
    await store.getState().reloadFile('a', true);
    expect(store.getState().previews.a?.draft).toBe('磁盘新内容');
  });

  it('刷新中的旧文件响应不能覆盖开始输入后的草稿', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    const pending = deferred<FileResult>();
    api.read.mockReturnValueOnce(pending.promise);
    const refresh = store.getState().refresh();
    store.getState().editFile('a', '新输入');
    pending.resolve(ready('旧响应'));
    await refresh;
    expect(store.getState().previews.a?.draft).toBe('新输入');
  });

  it('Markdown 默认渲染预览，可切换双栏且各文件模式独立', async () => {
    const store = createFilesStore(fakeApi(), 'ws');
    await store.getState().openFile({ ...file('md'), name: 'README.md' });
    expect(store.getState().previews.md?.mode).toBe('preview');
    store.getState().setMode('md', 'split');
    await store.getState().openFile(file('a'));
    expect(store.getState().previews.a?.mode).toBe('edit');
    expect(store.getState().previews.md?.mode).toBe('split');
  });
  it('旧 preload 没有文件接口时，提示重启而不是误报文件权限错误', async () => {
    const store = createFilesStore(undefined, 'ws');
    await store.getState().loadDirectory();
    expect(store.getState().directories[ROOT_DIRECTORY_ID]).toMatchObject({
      loading: false,
      error: 'restartRequired',
    });
    await store.getState().openFile(file('a'));
    expect(store.getState().previews.a).toMatchObject({
      loading: false,
      preview: null,
      error: 'restartRequired',
    });
  });

  it('按需加载根目录，展开目录只传 id，重复打开文件不产生重复标签', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().loadDirectory();
    expect(api.list).toHaveBeenLastCalledWith({ workspaceId: 'ws' });
    expect(store.getState().directories[ROOT_DIRECTORY_ID]?.entries).toEqual([file('a')]);
    await store.getState().toggleDirectory('dir');
    expect(api.list).toHaveBeenLastCalledWith({ workspaceId: 'ws', directoryId: 'dir' });
    await store.getState().openFile(file('a'));
    await store.getState().openFile(file('a'));
    expect(store.getState().opened).toEqual([file('a')]);
    expect(api.read).toHaveBeenCalledTimes(1);
  });

  it('关闭当前标签后选中相邻标签，最后一个关闭后回到空预览', async () => {
    const store = createFilesStore(fakeApi(), 'ws');
    await store.getState().openFile(file('a'));
    await store.getState().openFile(file('b'));
    store.getState().closeFile('b');
    expect(store.getState().selectedId).toBe('a');
    expect(store.getState().previews.b).toBeUndefined();
    store.getState().closeFile('a');
    expect(store.getState().selectedId).toBeNull();
  });

  it('快速切换文件时，旧文件的慢响应不会夺走当前选择', async () => {
    const api = fakeApi();
    const slow = deferred<FileResult>();
    api.read.mockReturnValueOnce(slow.promise);
    const store = createFilesStore(api, 'ws');
    const first = store.getState().openFile(file('a'));
    await store.getState().openFile(file('b'));
    slow.resolve(ready('旧文件'));
    await first;
    expect(store.getState().selectedId).toBe('b');
    expect(store.getState().previews.b?.preview).toMatchObject({ text: '内容' });
  });

  it('关闭后重开同一文件时丢弃旧响应', async () => {
    const api = fakeApi();
    const slow = deferred<FileResult>();
    api.read.mockReturnValueOnce(slow.promise);
    const store = createFilesStore(api, 'ws');
    const first = store.getState().openFile(file('a'));
    store.getState().closeFile('a');
    await store.getState().openFile(file('a'));
    slow.resolve(ready('过期'));
    await first;
    expect(store.getState().previews.a?.preview).toMatchObject({ text: '内容' });
  });

  it('刷新重新加载展开目录及打开文件，保持已选标签', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().loadDirectory();
    await store.getState().toggleDirectory('dir');
    await store.getState().openFile(file('a'));
    await store.getState().openFile(file('b'));
    api.read.mockResolvedValue(ready('更新'));
    await store.getState().refresh();
    expect(api.list).toHaveBeenCalledTimes(4);
    expect(store.getState().selectedId).toBe('b');
    expect(store.getState().previews.a?.preview).toMatchObject({ text: '更新' });
  });

  it('刷新期间旧目录响应不能覆盖新目录列表', async () => {
    const api = fakeApi();
    const slow = deferred<DirectoryResult>();
    api.list.mockReturnValueOnce(slow.promise);
    const store = createFilesStore(api, 'ws');
    const first = store.getState().loadDirectory();
    await store.getState().refresh();
    slow.resolve({ ok: true, entries: [file('old')], truncated: false });
    await first;
    expect(store.getState().directories[ROOT_DIRECTORY_ID]?.entries).toEqual([file('a')]);
  });

  it('失败可重试，不把旧正文伪装成最新内容', async () => {
    const api = fakeApi();
    const store = createFilesStore(api, 'ws');
    await store.getState().openFile(file('a'));
    api.read.mockResolvedValueOnce({ ok: false, error: 'entryNotFound' });
    await store.getState().refresh();
    expect(store.getState().previews.a).toMatchObject({
      loading: false,
      preview: null,
      error: 'entryNotFound',
    });
    await store.getState().openFile(file('a'));
    expect(store.getState().previews.a?.preview).toMatchObject({ text: '内容' });
  });

  it('两个工作区的响应与打开标签彼此隔离', async () => {
    const api = fakeApi();
    const first = createFilesStore(api, 'first');
    const second = createFilesStore(api, 'second');
    await first.getState().openFile(file('a'));
    expect(second.getState().opened).toEqual([]);
    await second.getState().openFile(file('b'));
    expect(api.read).toHaveBeenLastCalledWith({ workspaceId: 'second', fileId: 'b' });
    expect(first.getState().selectedId).toBe('a');
  });
});
