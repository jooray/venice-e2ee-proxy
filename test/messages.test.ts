import { describe, it, expect } from 'vitest';
import { mergeSystemMessages } from '../src/messages.js';

describe('mergeSystemMessages', () => {
  it('leaves a request with one system message untouched', () => {
    const messages = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ];
    expect(mergeSystemMessages(messages)).toBe(messages);
  });

  it('leaves a single non-leading system message where it is', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'system', content: 'Answer in French.' },
      { role: 'user', content: 'Say hi' },
    ];
    expect(mergeSystemMessages(messages)).toBe(messages);
  });

  it('merges consecutive system messages with a blank line', () => {
    const out = mergeSystemMessages([
      { role: 'system', content: 'First system.' },
      { role: 'system', content: 'Second system.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'First system.\n\nSecond system.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('pulls later system messages into the first one, keeping everything else in order', () => {
    const out = mergeSystemMessages([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'system', content: 'Now answer in French.' },
      { role: 'user', content: 'Say hi' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'Be brief.\n\nNow answer in French.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Say hi' },
    ]);
  });

  it('places the merged message where the first system message was', () => {
    const out = mergeSystemMessages([
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'A' },
      { role: 'assistant', content: 'Hi' },
      { role: 'system', content: 'B' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'system', 'assistant']);
    expect(out[1].content).toBe('A\n\nB');
  });

  it('flattens content-part arrays instead of producing [object Object]', () => {
    const out = mergeSystemMessages([
      { role: 'system', content: [{ type: 'text', text: 'Part one, ' }, { type: 'text', text: 'part two.' }] },
      { role: 'system', content: 'Plain.' },
      { role: 'user', content: 'Hi' },
    ]);
    expect(out[0].content).toBe('Part one, part two.\n\nPlain.');
    expect(JSON.stringify(out)).not.toContain('[object Object]');
  });

  it('drops empty system parts instead of leaving stray blank lines', () => {
    const out = mergeSystemMessages([
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: '' },
      { role: 'system', content: null },
      { role: 'user', content: 'Hi' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('appends the tool prompt after the merged system content', () => {
    const out = mergeSystemMessages(
      [
        { role: 'system', content: 'One.' },
        { role: 'system', content: 'Two.' },
        { role: 'user', content: 'Hi' },
      ],
      'TOOLS'
    );
    expect(out).toEqual([
      { role: 'system', content: 'One.\n\nTwo.\n\nTOOLS' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('prepends the tool prompt as a system message when there is none', () => {
    const out = mergeSystemMessages([{ role: 'user', content: 'Hi' }], 'TOOLS');
    expect(out).toEqual([
      { role: 'system', content: 'TOOLS' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('does not merge repeated user, assistant or tool turns', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'tool', content: 'e', tool_call_id: 'call_1' },
      { role: 'tool', content: 'f', tool_call_id: 'call_2' },
    ];
    expect(mergeSystemMessages(messages)).toBe(messages);
  });
});
