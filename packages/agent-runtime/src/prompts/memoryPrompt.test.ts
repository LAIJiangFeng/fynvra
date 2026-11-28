import { describe, expect, it } from 'vitest';
import { memoryPrompt } from './memoryPrompt';

describe('memoryPrompt', () => {
  it('injects nothing when there are no entries and the session cannot write', () => {
    expect(memoryPrompt({ index: '', write: false })).toBeUndefined();
    expect(memoryPrompt({ index: ' \n', write: false })).toBeUndefined();
  });

  it('wraps the index as is, with read rules only for a read-only session', () => {
    const index = '- #1 [rule] Use pnpm\n- #2 [pitfall] Clear the cache';
    const prompt = memoryPrompt({ index, write: false }) as string;
    expect(prompt.startsWith('<project_memory>\n')).toBe(true);
    expect(prompt.endsWith('\n</project_memory>')).toBe(true);
    expect(prompt).toContain(index);
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('project_memory_search');
    expect(prompt).toContain('project_memory_feedback');
    expect(prompt).toContain('ctx_*');
    expect(prompt).not.toContain('project_memory_write');
  });

  it('adds the write rules only for a writable session, even without entries', () => {
    const prompt = memoryPrompt({ index: '', write: true }) as string;
    expect(prompt).toContain('project_memory_write');
    expect(prompt).toContain('No entries yet.');
  });
});
