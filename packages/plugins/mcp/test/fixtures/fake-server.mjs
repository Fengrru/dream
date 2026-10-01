/**
 * Minimal fake MCP stdio server for tests: newline-delimited JSON-RPC 2.0.
 * Tools: `echo(text)` and `add(a, b)`.
 */
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx < 0) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue; // notification
    let result;
    let error;
    switch (msg.method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-mcp', version: '0.0.1' },
        };
        break;
      case 'tools/list':
        result = {
          tools: [
            { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
            { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
            { name: 'explode', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
          ],
        };
        break;
      case 'tools/call': {
        const params = msg.params ?? {};
        if (params.name === 'echo') {
          result = { content: [{ type: 'text', text: `echo:${params.arguments?.text ?? ''}` }] };
        } else if (params.name === 'add') {
          result = { content: [{ type: 'text', text: String((params.arguments?.a ?? 0) + (params.arguments?.b ?? 0)) }] };
        } else if (params.name === 'explode') {
          result = { content: [{ type: 'text', text: 'boom' }], isError: true };
        } else {
          error = { code: -32601, message: `unknown tool ${params.name}` };
        }
        break;
      }
      default:
        error = { code: -32601, message: `unknown method ${msg.method}` };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result, error }) + '\n');
  }
});
