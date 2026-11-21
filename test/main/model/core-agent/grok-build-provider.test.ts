import { describe, expect, it } from 'vitest';
import { formatGrokBuildPrompt } from '../../../../src/main/model/core-agent/grok-build-provider';

describe('grok-build-provider', () => {
  it('serializes ordinary chat history and explicitly denies tool use', () => {
    const prompt = formatGrokBuildPrompt({
      model: 'grok-4.7',
      systemPrompt: 'Answer in Chinese.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        { role: 'assistant', content: [{ type: 'text', text: '你好！' }] },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    });

    expect(prompt).toContain('Do not use tools');
    expect(prompt).toContain('[SYSTEM]\nAnswer in Chinese.');
    expect(prompt).toContain('[USER]\n你好');
    expect(prompt).toContain('[ASSISTANT]\n你好！');
    expect(prompt).toMatch(/\[USER\]\n继续\n\n\[ASSISTANT\]$/);
  });
});
