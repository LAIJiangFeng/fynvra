import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { SEED } from './seed';

test('在文件目录打开预置文件后编辑器显示其内容', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByText(SEED.workspace.name).tap();
  await screen.getByRole('navigation', '文件目录').getByRole('button', SEED.file.name).tap();
  await expect(screen.getByRole('textbox', `编辑 ${SEED.file.name}`)).toHaveText(SEED.file.content);
});
