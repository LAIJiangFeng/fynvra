export interface TerminalCreateRequest {
  id: string;
  workspaceId: string;
  cols: number;
  rows: number;
}

export type TerminalEvent =
  | { id: string; type: 'data'; data: string }
  | { id: string; type: 'exit'; exitCode: number };
