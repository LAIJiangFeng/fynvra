import { errorMessage } from '@shared/guards';
import type { SessionSummary } from '@shared/types/chat';
import type { WatchdogPreferences } from '@shared/types/settings';
import type { AgentHostService } from './agentHost';

/** 退避上限：30 分钟 */
const MAX_BACKOFF_MS = 30 * 60_000;
const REASON_MAX_CHARS = 500;

type CandidateSource = 'model' | 'host' | 'compaction' | 'stalled';

interface Candidate {
  /** 失败时间（退避从这里算） */
  at: number;
  source: CandidateSource;
  message: string;
}

interface Track {
  candidate?: Candidate;
  /** 本轮连续自动恢复次数；正常结束一轮时清零 */
  attempts: number;
  /** 当前这一轮里出现过 error 事件：模型错误后紧跟的 agent_settled{aborted:false} 不能清掉候选 */
  roundError: boolean;
  /** 达到上限后只记一次日志 */
  gaveUp: boolean;
  lastEventAt?: number;
  /** 正在执行的工具（toolCallId） */
  tools: Set<string>;
  /** 卡住检测：检查时第一次看到它在运行的时间，从这里开始计时 */
  seenRunningAt?: number;
}

export interface SessionWatchdogHosts {
  agentHost: Pick<AgentHostService, 'get' | 'observe' | 'abort' | 'resumeAfterInterruption'>;
  /** 每次检查都重读，改了设置下一次检查就生效 */
  preferences(): WatchdogPreferences;
  /** 是否主 agent 会话（内置主 agent，或角色 tools 为 orchestrator） */
  isOrchestrator(session: SessionSummary): boolean | Promise<boolean>;
  log?(message: string): void;
}

export interface SessionWatchdogOptions {
  now?: () => number;
}

export function resumePrompt(attempt: number, maxAttempts: number, reason: string): string {
  const clipped =
    reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason;
  return `[Fynvra watchdog] Automatic resume (attempt ${attempt}/${maxAttempts}) — not a message from the user. The previous turn stopped: ${clipped}. First check the current state (for an orchestrator: list_workers and pending reviews), then continue the unfinished work without redoing completed steps. If everything is already done, or a decision from the user is needed, say so briefly and stop.`;
}

const isDispatched = (session: SessionSummary) =>
  session.dispatchId !== undefined || session.parentSessionId !== undefined;

/**
 * 会话守护：只在应用运行期间、只在内存里工作。开启后记录到的模型错误 / 宿主错误 / 卡住，按间隔检查、
 * 指数退避、有上限地自动发恢复消息；开启前或启动前的失败不复活，用户停止的会话不恢复，派发的 worker 不恢复。
 * 返回停止函数。
 */
export function installSessionWatchdog(
  hosts: SessionWatchdogHosts,
  options: SessionWatchdogOptions = {}
): () => void {
  const now = options.now ?? Date.now;
  const log = hosts.log ?? ((message: string) => console.warn(`[watchdog] ${message}`));
  const tracks = new Map<string, Track>();
  /** 守护自己发起的 abort：同步发出的 abort 活动不当作用户停止 */
  const selfAborting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const trackOf = (sessionId: string): Track => {
    let track = tracks.get(sessionId);
    if (!track) {
      track = { attempts: 0, roundError: false, gaveUp: false, tools: new Set() };
      tracks.set(sessionId, track);
    }
    return track;
  };

  const unsubscribe = hosts.agentHost.observe({
    event: ({ sessionId, event }) => {
      const track = trackOf(sessionId);
      track.lastEventAt = now();
      switch (event.type) {
        case 'tool_start':
          track.tools.add(event.toolCallId);
          return;
        case 'tool_end':
          track.tools.delete(event.toolCallId);
          return;
        case 'error':
          track.roundError = true;
          // 只记录开启期间的失败：开启前、启动前的失败都不自动恢复
          if (hosts.preferences().enabled)
            track.candidate = { at: now(), source: event.source, message: event.message };
          return;
        case 'agent_settled':
          track.tools.clear();
          if (!event.aborted && !track.roundError) {
            track.candidate = undefined;
            track.attempts = 0;
            track.gaveUp = false;
          }
          track.roundError = false;
          return;
      }
    },
    activity: (sessionId, action) => {
      const track = trackOf(sessionId);
      if (action === 'prompt') {
        track.candidate = undefined;
        track.roundError = false;
      } else if (action === 'abort' && !selfAborting.has(sessionId)) {
        // 用户点停止（或会话被关闭）：不恢复
        track.candidate = undefined;
      } else if (action === 'resume') {
        track.roundError = false;
      }
    },
  });

  const inScope = async (session: SessionSummary, prefs: WatchdogPreferences): Promise<boolean> => {
    if (isDispatched(session)) return false;
    if (prefs.scope === 'all') return true;
    try {
      return await hosts.isOrchestrator(session);
    } catch (error) {
      log(`session ${session.id}: role lookup failed: ${errorMessage(error)}`);
      return false;
    }
  };

  const triggerOn = (source: CandidateSource, prefs: WatchdogPreferences): boolean =>
    source === 'model'
      ? prefs.onModelError
      : source === 'host'
        ? prefs.onCrash
        : source === 'stalled'
          ? prefs.onStall
          : false;

  const checkStall = async (
    sessionId: string,
    session: SessionSummary,
    track: Track,
    prefs: WatchdogPreferences
  ): Promise<void> => {
    if (!prefs.onStall || session.status !== 'running' || session.archivedAt !== undefined) {
      track.seenRunningAt = undefined;
      return;
    }
    const at = now();
    if (track.seenRunningAt === undefined) {
      track.seenRunningAt = at;
      return;
    }
    if (track.tools.size > 0) return;
    const quietSince = Math.max(track.lastEventAt ?? 0, track.seenRunningAt);
    if (at - quietSince < prefs.stallMinutes * 60_000) return;
    const scoped = await inScope(session, prefs);
    if (!scoped && !isDispatched(session)) return;
    // await 之后重查：期间可能已经有了新事件或状态变化
    if (
      hosts.agentHost.get(sessionId)?.status !== 'running' ||
      track.tools.size > 0 ||
      Math.max(track.lastEventAt ?? 0, track.seenRunningAt ?? at) !== quietSince
    )
      return;
    log(`session ${sessionId}: no output for ${prefs.stallMinutes} minutes; aborting the turn`);
    track.seenRunningAt = undefined;
    let result: Awaited<ReturnType<typeof hosts.agentHost.abort>>;
    // abort 活动在 abort() 的同步部分发出：只在这段里算守护自己的，之后的都算用户停止
    selfAborting.add(sessionId);
    try {
      const pending = hosts.agentHost.abort(sessionId);
      selfAborting.delete(sessionId);
      result = await pending;
    } catch (error) {
      log(`session ${sessionId}: abort failed: ${errorMessage(error)}`);
      return;
    } finally {
      selfAborting.delete(sessionId);
    }
    if (!result.ok) {
      log(`session ${sessionId}: abort failed: ${result.error}`);
      return;
    }
    // 派发的 worker 由编排报告给主 agent；范围内的会话记为候选，之后自动恢复
    if (scoped) {
      track.candidate = {
        at: now(),
        source: 'stalled',
        message: `stalled: no output for ${prefs.stallMinutes} minutes`,
      };
    }
  };

  const checkResume = async (
    sessionId: string,
    session: SessionSummary,
    track: Track,
    prefs: WatchdogPreferences
  ): Promise<void> => {
    const candidate = track.candidate;
    if (!candidate) return;
    const stalled = candidate.source === 'stalled';
    if (session.archivedAt !== undefined) return;
    if (!(session.status === 'error' || (stalled && session.status === 'idle'))) return;
    if (!triggerOn(candidate.source, prefs)) {
      if (candidate.source === 'compaction') {
        log(`session ${sessionId}: compaction failed; context recovery is needed, not resuming`);
        track.candidate = undefined;
      }
      return;
    }
    if (session.contextRuntime?.recoveryRequired) {
      log(`session ${sessionId}: context recovery is required, not resuming`);
      track.candidate = undefined;
      return;
    }
    if (!(await inScope(session, prefs))) return;
    if (track.attempts >= prefs.maxAttempts) {
      if (!track.gaveUp) {
        track.gaveUp = true;
        log(
          `session ${sessionId}: reached ${prefs.maxAttempts} automatic resumes; waiting for the user`
        );
      }
      return;
    }
    const backoff = Math.min(prefs.intervalSeconds * 1000 * 2 ** track.attempts, MAX_BACKOFF_MS);
    if (now() - candidate.at < backoff) return;
    const attempt = track.attempts + 1;
    try {
      const sent = await hosts.agentHost.resumeAfterInterruption(
        sessionId,
        resumePrompt(attempt, prefs.maxAttempts, candidate.message),
        stalled ? { fromIdle: true } : undefined
      );
      if (!sent.ok) throw new Error(sent.error);
      if (!sent.delivered) return; // 用户操作或状态变化抢先：下一次检查再看
      // await 期间若候选被用户操作清掉 / 换掉，也照样计数：消息已经发出
      track.attempts = attempt;
      if (track.candidate === candidate) track.candidate = undefined;
      log(`session ${sessionId}: automatic resume ${attempt}/${prefs.maxAttempts} sent`);
    } catch (error) {
      log(`session ${sessionId}: automatic resume failed: ${errorMessage(error)}`);
    }
  };

  const check = async (): Promise<void> => {
    const prefs = hosts.preferences();
    if (!prefs.enabled) {
      // 关闭期间的旧候选不保留：重新开启后不复活
      for (const track of tracks.values()) {
        track.candidate = undefined;
        track.seenRunningAt = undefined;
      }
      return;
    }
    for (const [sessionId, track] of [...tracks]) {
      const session = hosts.agentHost.get(sessionId);
      if (!session) {
        tracks.delete(sessionId);
        continue;
      }
      await checkStall(sessionId, session, track, prefs);
      const current = hosts.agentHost.get(sessionId);
      if (current) await checkResume(sessionId, current, track, prefs);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void check()
        .catch((error: unknown) => log(`check failed: ${errorMessage(error)}`))
        .finally(schedule);
    }, hosts.preferences().intervalSeconds * 1000);
  };
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
}
