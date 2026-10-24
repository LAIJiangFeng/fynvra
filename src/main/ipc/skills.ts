import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord, errorMessage } from '@shared/guards';
import { IPC_CHANNELS, type IpcResult } from '@shared/types/ipc';
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron';
import type {
  SkillAddResult,
  SkillListResult,
  SkillScanResult,
  SkillToggleResult,
} from '../../preload/domains/skills';
import { isRegistryId } from '../services/providers/jsonRegistry';
import {
  parseSkillCandidateId,
  resolveSkillCandidate,
  scanLocalSkills,
} from '../services/skills/scanSkills';
import { readSkillManifest } from '../services/skills/skillManifest';
import {
  createSkillRegistry,
  type SkillRegistry,
  type SkillToRegister,
} from '../services/skills/skillRegistry';
import { sendToAllWindows } from '../windows/createAppWindow';

let registry: SkillRegistry | null = null;

/** Main 唯一的 skills.json 句柄；会话按角色的 skillIds 取技能目录也走这里。 */
export function getSkillRegistry(): SkillRegistry {
  registry ??= createSkillRegistry({ filePath: join(app.getPath('userData'), 'skills.json') });
  return registry;
}

const MAX_CANDIDATES = 500;

export function registerSkillHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SKILLS_LIST, async (): Promise<SkillListResult> => {
    try {
      return { ok: true, skills: await getSkillRegistry().list() };
    } catch (error) {
      return { ok: false, error: `读取技能失败：${errorMessage(error)}` };
    }
  });

  // 无参：Main 弹目录选择框；{ candidateIds }：登记 skills:scan 的结果。两种方式都不接收路径
  ipcMain.handle(IPC_CHANNELS.SKILLS_ADD, async (event, raw: unknown): Promise<SkillAddResult> => {
    try {
      if (raw === undefined) return await addFromDialog(event.sender);
      const candidateIds = parseCandidateIds(raw);
      if (!candidateIds) return { ok: false, code: 'invalid', error: '无效的技能参数' };
      return await addCandidates(candidateIds);
    } catch (error) {
      return { ok: false, code: 'failed', error: errorMessage(error) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.SKILLS_REMOVE, async (_event, rawId: unknown): Promise<IpcResult> => {
    if (!isRegistryId(rawId)) return { ok: false, error: '无效的技能 id' };
    try {
      const removed = await getSkillRegistry().remove(rawId);
      if (!removed) return { ok: false, error: '技能不存在' };
      sendToAllWindows(IPC_CHANNELS.SKILLS_CHANGED);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `移除技能失败：${errorMessage(error)}` };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILLS_TOGGLE,
    async (_event, raw: unknown): Promise<SkillToggleResult> => {
      const input = parseToggle(raw);
      if (!input) return { ok: false, error: '无效的参数' };
      try {
        const skill = await getSkillRegistry().setEnabled(input.id, input.enabled);
        if (!skill) return { ok: false, error: '技能不存在' };
        sendToAllWindows(IPC_CHANNELS.SKILLS_CHANGED);
        return { ok: true, skill };
      } catch (error) {
        return { ok: false, error: `更新技能失败：${errorMessage(error)}` };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.SKILLS_SCAN, async (): Promise<SkillScanResult> => {
    try {
      const registered = await getSkillRegistry().list();
      return { ok: true, ...(await scanLocalSkills({ home: homedir(), registered })) };
    } catch (error) {
      return { ok: false, error: `扫描技能失败：${errorMessage(error)}` };
    }
  });
}

async function addFromDialog(sender: Electron.WebContents): Promise<SkillAddResult> {
  const dir = await pickDirectory(sender);
  if (!dir) return { ok: false, code: 'canceled', error: '已取消选择' };
  const manifest = await readSkillManifest(dir);
  if (!manifest.ok) return { ok: false, code: 'invalid', error: manifest.error };
  const { added, skipped } = await getSkillRegistry().add([{ ...manifest.manifest, path: dir }]);
  if (added.length === 0) return { ok: false, code: 'invalid', error: skipped[0] ?? '技能已登记' };
  sendToAllWindows(IPC_CHANNELS.SKILLS_CHANGED);
  return { ok: true, skills: added, skipped };
}

async function addCandidates(candidateIds: readonly string[]): Promise<SkillAddResult> {
  const home = homedir();
  const found: SkillToRegister[] = [];
  const skipped: string[] = [];
  for (const id of candidateIds) {
    const dir = resolveSkillCandidate(id, home);
    const manifest = dir ? await readSkillManifest(dir) : null;
    if (dir && manifest?.ok) found.push({ ...manifest.manifest, path: dir });
    else skipped.push(manifest && !manifest.ok ? manifest.error : `${id}：无效的候选`);
  }
  const result = await getSkillRegistry().add(found);
  if (result.added.length > 0) sendToAllWindows(IPC_CHANNELS.SKILLS_CHANGED);
  return { ok: true, skills: result.added, skipped: [...skipped, ...result.skipped] };
}

/** `{ candidateIds: string[] }`，每个 id 都必须是合法候选 id，否则整个请求作废。 */
function parseCandidateIds(raw: unknown): string[] | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'candidateIds')) return null;
  const { candidateIds } = record;
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return null;
  if (candidateIds.length > MAX_CANDIDATES) return null;
  if (!candidateIds.every((id) => parseSkillCandidateId(id) !== null)) return null;
  return [...new Set(candidateIds as string[])];
}

function parseToggle(raw: unknown): { id: string; enabled: boolean } | null {
  const record = asRecord(raw);
  if (!record || Object.keys(record).some((key) => key !== 'id' && key !== 'enabled')) return null;
  const { id, enabled } = record;
  return isRegistryId(id) && typeof enabled === 'boolean' ? { id, enabled } : null;
}

async function pickDirectory(sender: Electron.WebContents): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: '选择技能目录（含 SKILL.md）',
    buttonLabel: '添加',
    properties: ['openDirectory'],
  };
  const win = BrowserWindow.fromWebContents(sender);
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}
