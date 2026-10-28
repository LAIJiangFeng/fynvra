import { describe, expectTypeOf, it } from 'vitest';
import type { FynvraSessionEvent, FynvraSessionEventBody } from './index';

// 纯类型断言：由 typecheck（tsc -p packages/core）检查，运行时什么都不做。
describe('session events', () => {
  it('变体与 ARCHITECTURE §5 的事件列表逐项一致', () => {
    expectTypeOf<FynvraSessionEventBody['type']>().toEqualTypeOf<
      | 'text_delta'
      | 'thinking_delta'
      | 'tool_start'
      | 'tool_end'
      | 'message_end'
      | 'agent_settled'
      | 'approval_request'
      | 'usage'
      | 'warning'
      | 'error'
    >();
  });

  it('每条事件都带数字 seq', () => {
    expectTypeOf<FynvraSessionEvent['seq']>().toEqualTypeOf<number>();
    expectTypeOf<FynvraSessionEvent['type']>().toEqualTypeOf<FynvraSessionEventBody['type']>();
  });
});
