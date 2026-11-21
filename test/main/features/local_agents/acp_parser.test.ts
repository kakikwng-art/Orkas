import { describe, it, expect, vi } from 'vitest';
import { handleAcpMessage } from '../../../../src/main/features/local_agents/backends/_acp';
import { AcpUsageShapeDiagnostics } from '../../../../src/main/features/local_agents/backends/acp-diagnostics';

function makeHandlers() {
  return {
    onSessionNew: vi.fn(),
    onTextDelta: vi.fn(),
    onThinking: vi.fn(),
    onToolUse: vi.fn(),
    onToolResult: vi.fn(),
    onMediaOutput: vi.fn(),
    onUsageUpdate: vi.fn(),
    onPromptResult: vi.fn(),
    onUnknown: vi.fn(),
  };
}

describe('local_agents/backends/_acp › handleAcpMessage', () => {
  it('routes session/new response to onSessionNew', () => {
    const h = makeHandlers();
    handleAcpMessage({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-x' } }, h);
    expect(h.onSessionNew).toHaveBeenCalledWith('sess-x');
  });

  it('routes session/update agent_message_chunk to onTextDelta (kind field)', () => {
    const h = makeHandlers();
    handleAcpMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's', update: { kind: 'agent_message_chunk', content: { text: 'hello' } } },
    }, h);
    expect(h.onTextDelta).toHaveBeenCalledWith('hello');
    expect(h.onThinking).not.toHaveBeenCalled();
  });

  it('routes session/update agent_message_chunk via sessionUpdate field (Hermes wire format)', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } },
    }, h);
    expect(h.onTextDelta).toHaveBeenCalledWith('hi');
    expect(h.onThinking).not.toHaveBeenCalled();
  });

  it('routes agent_thought_chunk to onThinking', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: '(◔_◔) mulling' } } },
    }, h);
    expect(h.onThinking).toHaveBeenCalledWith('(◔_◔) mulling');
    expect(h.onTextDelta).not.toHaveBeenCalled();
  });

  it('available_commands_update goes to onUnknown (not pretending to be a tool)', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help' }] } },
    }, h);
    expect(h.onToolUse).not.toHaveBeenCalled();
    expect(h.onUnknown).toHaveBeenCalled();
  });

  it('routes tool_call to onToolUse', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { kind: 'tool_call', tool: { id: 'c1', name: 'read_file', input: { path: 'x.md' } } } },
    }, h);
    expect(h.onToolUse).toHaveBeenCalledWith({ name: 'read_file', callId: 'c1', input: { path: 'x.md' } });
  });

  it('routes tool_call_update to onToolResult, stringifying non-string output', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { kind: 'tool_call_update', tool: { id: 'c1', name: 'read_file', output: { lines: 4 } } } },
    }, h);
    expect(h.onToolResult).toHaveBeenCalledWith({ name: 'read_file', callId: 'c1', output: '{"lines":4}' });
  });

  it('supports the current ACP root tool fields and standard image content', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'image-1',
        title: 'image_generate',
        rawInput: { prompt: 'a fox' },
      } },
    }, h);
    handleAcpMessage({
      method: 'session/update',
      params: { update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'image-1',
        status: 'completed',
        content: [{ type: 'content', content: {
          type: 'image', data: 'AAAA', mimeType: 'image/png', uri: 'file:///tmp/image.png',
        } }],
        rawOutput: { ok: true },
      } },
    }, h);
    expect(h.onToolUse).toHaveBeenCalledWith({
      name: 'image_generate', callId: 'image-1', input: { prompt: 'a fox' },
    });
    expect(h.onToolResult).toHaveBeenCalledWith({
      name: 'tool', callId: 'image-1', output: '{"ok":true}', status: 'completed',
    });
    expect(h.onMediaOutput).toHaveBeenCalledWith({
      callId: 'image-1',
      items: [{ data: 'AAAA', uri: 'file:///tmp/image.png', mediaType: 'image/png' }],
    });
  });

  it('prefers the readable transcript over byte-array raw output', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'b-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'fallback text' } }],
        rawOutput: { type: 'Bash', output: [13, 10, 68, 111, 110, 101], output_for_prompt: 'readable transcript' },
      } },
    }, h);
    expect(h.onToolResult).toHaveBeenCalledWith({
      name: 'tool', callId: 'b-1', output: 'readable transcript', status: 'completed',
    });
  });

  it('extracts the Hermes image_generate URL from rawOutput JSON', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'image-2',
        rawOutput: '{"success":true,"image":"https://cdn.example/hermes.png"}',
      } },
    }, h);
    expect(h.onMediaOutput).toHaveBeenCalledWith({
      callId: 'image-2',
      items: [{ uri: 'https://cdn.example/hermes.png' }],
    });
  });

  it('marks prompt response (id=100) ok=true on end_turn', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 100, result: { stopReason: 'end_turn' } }, h);
    expect(h.onPromptResult).toHaveBeenCalledWith({ ok: true, error: undefined });
  });

  it('marks prompt response ok=false for non-end_turn stop reasons', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 100, result: { stopReason: 'cancelled' } }, h);
    expect(h.onPromptResult).toHaveBeenCalledWith({ ok: false, error: 'cancelled' });
  });

  it('marks prompt response ok=false on rpc error envelope', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 100, error: { message: 'auth fail' } }, h);
    expect(h.onPromptResult).toHaveBeenCalledWith({ ok: false, error: 'auth fail' });
  });

  it('forwards unknown session/update kinds to onUnknown', () => {
    const h = makeHandlers();
    handleAcpMessage({
      method: 'session/update',
      params: { update: { kind: 'something_new', payload: 1 } },
    }, h);
    expect(h.onUnknown).toHaveBeenCalled();
  });

  it('routes only the usage update body to diagnostics without guessing token fields', () => {
    const h = makeHandlers();
    const event = {
      method: 'session/update',
      params: { update: { sessionUpdate: 'usage_update', vendorCounters: { opaque: 7 } } },
    };
    handleAcpMessage(event, h);
    expect(h.onUsageUpdate).toHaveBeenCalledWith(event.params.update);
    expect(h.onUnknown).not.toHaveBeenCalled();
    expect(h.onPromptResult).not.toHaveBeenCalled();
  });

  it('records only bounded usage field paths, types, and event count', () => {
    const diagnostic = new AcpUsageShapeDiagnostics();
    diagnostic.observe({ sessionUpdate: 'usage_update', usage: {
      inputTokens: 12, nested: [{ cache: 3 }], account: 'private-account',
      prompt: 'private prompt', path: 'C:/private/file',
    } });
    diagnostic.observe({ sessionUpdate: 'usage_update', usage: { inputTokens: 18 } });
    const snapshot = diagnostic.snapshot();
    expect(snapshot).toMatchObject({ received: true, eventCount: 2 });
    expect(snapshot.fieldTypes).toEqual(expect.arrayContaining([
      'usage.inputTokens:number', 'usage.nested:array', 'usage.nested[].cache:number',
    ]));
    expect(snapshot.fieldTypes).not.toEqual(expect.arrayContaining([
      'usage.account:string', 'usage.prompt:string', 'usage.path:string',
    ]));
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('private-account');
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('C:/private/file');
    expect(new AcpUsageShapeDiagnostics().snapshot()).toEqual({
      received: false, eventCount: 0, fieldTypes: [],
    });
  });

  it('ignores unrelated request errors silently', () => {
    const h = makeHandlers();
    handleAcpMessage({ id: 3, error: { message: 'unknown method' } }, h);
    expect(h.onPromptResult).not.toHaveBeenCalled();
  });
});
