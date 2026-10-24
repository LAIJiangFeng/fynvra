import type {
  FynvraSessionEvent as CoreSessionEvent,
  FynvraSessionEventBody as CoreSessionEventBody,
} from '@fynvra/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  approvalKindOf,
  buildRolePromptAppend,
  checkGitArgs,
  createApprovalGate,
  createEventNormalizer,
  createGitReadonlyTool,
  createOrchestrationTools,
  createReadonlyTools,
  createRoleSession,
  createWorkerTools,
  describeToolCall,
  type FynvraSessionEvent,
  type FynvraSessionEventBody,
  modeRequiresApproval,
  nodeExec,
  ORCHESTRATION_TOOL_METHODS,
  ORCHESTRATOR_PROMPT,
  protectedAction,
  subscribeNormalized,
  WORKER_CONTRACT_PROMPT,
} from './index';

describe('@fynvra/agent-runtime entry point', () => {
  it('exposes the session factory, tool factories, approval gate, prompts and normalizer', () => {
    const functions = {
      createRoleSession,
      createOrchestrationTools,
      createWorkerTools,
      createReadonlyTools,
      createGitReadonlyTool,
      checkGitArgs,
      createEventNormalizer,
      subscribeNormalized,
      buildRolePromptAppend,
      nodeExec,
      createApprovalGate,
      approvalKindOf,
      modeRequiresApproval,
      describeToolCall,
      protectedAction,
    };
    for (const [name, value] of Object.entries(functions)) {
      expect(typeof value, name).toBe('function');
    }
    expect(typeof ORCHESTRATOR_PROMPT).toBe('string');
    expect(typeof WORKER_CONTRACT_PROMPT).toBe('string');
    expect(Object.keys(ORCHESTRATION_TOOL_METHODS)).toHaveLength(10);
  });

  it('re-exports the session event types of @fynvra/core', () => {
    expectTypeOf<FynvraSessionEvent>().toEqualTypeOf<CoreSessionEvent>();
    expectTypeOf<FynvraSessionEventBody>().toEqualTypeOf<CoreSessionEventBody>();
  });
});
