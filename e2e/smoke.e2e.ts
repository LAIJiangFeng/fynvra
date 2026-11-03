import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { SEED } from './seed';

test('启动后侧栏显示预置工作区', async ({ app, screen }) => {
  await app.open('/');
  // 工作区列表由 Main 读 settings.json 后经 preload 的 IPC 返回，能看到它也说明 preload 与 IPC 正常。
  await expect(screen.getByText(SEED.workspace.name)).toBeVisible();
});
