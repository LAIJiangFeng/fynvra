import { describe, expect, it } from 'vitest';
import { protectedAction } from './protectedCommand';

describe('protectedAction', () => {
  it.each([
    // rm -rf 的各种写法
    ['rm -rf build', 'rm -rf'],
    ['rm -fr build', 'rm -rf'],
    ['rm -Rf build', 'rm -rf'],
    ['rm -r -f build', 'rm -rf'],
    ['rm --recursive --force build', 'rm -rf'],
    ['rm -rfv dist node_modules', 'rm -rf'],
    // 不带 -f 的递归删除同样拦：PowerShell 里 rm -r 就是 Remove-Item -Recurse
    ['rm -r build', 'rm -rf'],
    ['/bin/rm -rf /tmp/x', 'rm -rf'],
    ['sudo rm -rf /var/cache', 'rm -rf'],
    ['find . -name "*.log" -exec rm -rf {} \\;', 'rm -rf'],
    ['bash -c "rm -rf out"', 'rm -rf'],
    ['cd build && rm -rf *', 'rm -rf'],
    ['RM -RF build', 'rm -rf'],
    // Remove-Item -Recurse（含 PowerShell 别名与参数前缀）
    ['Remove-Item -Recurse -Force .\\dist', 'Remove-Item -Recurse'],
    ['remove-item .\\dist -recurse', 'Remove-Item -Recurse'],
    ['Remove-Item dist -Recurse:$true', 'Remove-Item -Recurse'],
    ['Microsoft.PowerShell.Management\\Remove-Item -Rec dist', 'Remove-Item -Recurse'],
    ['ri -r dist', 'Remove-Item -Recurse'],
    ['Get-ChildItem x | ForEach-Object { Remove-Item $_ -Recurse }', 'Remove-Item -Recurse'],
    ['rmdir -Recurse dist', 'Remove-Item -Recurse'],
    // del /s（cmd）
    ['del /s /q build', 'del /s'],
    ['DEL /S build\\*.obj', 'del /s'],
    ['erase /q/s build', 'del /s'],
    ['rd /s /q build', 'del /s'],
    ['cmd //c del /s build', 'del /s'],
    // git push / git reset --hard
    ['git push', 'git push'],
    ['git push origin main --force', 'git push'],
    ['git -C ../repo push', 'git push'],
    ['git -c core.sshCommand=ssh push origin', 'git push'],
    ['git --no-pager push', 'git push'],
    ['"C:\\Program Files\\Git\\cmd\\git.exe" push', 'git push'],
    ['git add -A && git commit -m wip && git push', 'git push'],
    ['git reset --hard HEAD~1', 'git reset --hard'],
    ['git reset --hard', 'git reset --hard'],
    ['git -C repo reset origin/main --hard', 'git reset --hard'],
    // 包管理器 publish
    ['npm publish', 'npm publish'],
    ['pnpm -r publish --access public', 'pnpm publish'],
    ['yarn npm publish', 'yarn publish'],
    ['bun publish', 'bun publish'],
    ['cargo publish --dry-run', 'cargo publish'],
    ['corepack pnpm publish', 'pnpm publish'],
    ['npx jsr publish', 'jsr publish'],
  ])('%j → %s', (command, expected) => {
    expect(protectedAction(command)).toBe(expected);
  });

  it.each([
    'echo hi',
    'rm build/out.txt',
    'rm -f build/out.txt',
    'rm -i notes.txt',
    'Remove-Item dist -Force',
    'del build\\a.obj',
    'rd build',
    'ls -R',
    'grep -r TODO src',
    'cp -r a b',
    'git status',
    'git commit -m "fix the push button"',
    'git log --grep push',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git stash push -m wip',
    'pnpm test',
    'npm run build',
    'pnpm typecheck && pnpm lint && pnpm test',
    // 子命令位置上的 rm 不是删除程序
    'git rm -r --cached .',
    'pnpm rm -r left-pad',
    'docker rm -f web',
    '',
  ])('%j is not protected', (command) => {
    expect(protectedAction(command)).toBeUndefined();
  });

  it('catches a protected command anywhere in a compound command line', () => {
    expect(protectedAction('pnpm build; git push --tags')).toBe('git push');
    expect(protectedAction('pnpm test\nrm -rf coverage')).toBe('rm -rf');
    expect(protectedAction('pnpm test || git reset --hard')).toBe('git reset --hard');
    expect(protectedAction('echo `rm -rf x`')).toBe('rm -rf');
  });

  it('joins bash and PowerShell line continuations before matching', () => {
    expect(protectedAction('rm \\\n  -rf build')).toBe('rm -rf');
    expect(protectedAction('Remove-Item .\\dist `\r\n  -Recurse')).toBe('Remove-Item -Recurse');
  });
});
