/**
 * E2E check for the Dream gateway: chat (fact encoding + recall) and a dream
 * cycle, over the real WebSocket protocol. Uses Node's global WebSocket.
 */
const url = 'ws://127.0.0.1:7333';
const ws = new WebSocket(url);
const log = (...args) => console.log('[e2e]', ...args);

let phase = 'fact';
const timeout = setTimeout(() => {
  console.error('[e2e] TIMEOUT');
  process.exit(1);
}, 120_000);

ws.onopen = () => {
  log('connected');
  setTimeout(() => ws.send(JSON.stringify({ type: 'chat', text: 'My name is Ada and I live in Seattle' })), 300);
};

ws.onmessage = (msg) => {
  const frame = JSON.parse(String(msg.data));
  switch (frame.type) {
    case 'hello':
      log('hello:', frame.reasoning);
      break;
    case 'state':
      if (frame.cognitive) log('cognitive:', frame.cognitive, 'wm', frame.wmLoad);
      break;
    case 'recalled':
      log('recalled:', frame.count);
      break;
    case 'encode':
      log('encoded:', frame.entry?.kind, '-', String(frame.entry?.content).slice(0, 60));
      break;
    case 'reply':
      log('reply:', frame.text);
      if (phase === 'fact') {
        phase = 'recall';
        setTimeout(() => ws.send(JSON.stringify({ type: 'chat', text: 'What is my name?' })), 800);
      } else if (phase === 'recall') {
        phase = 'dream';
        setTimeout(() => ws.send(JSON.stringify({ type: 'dream' })), 500);
      }
      break;
    case 'dream-report':
      log('dream report:', JSON.stringify({
        replayed: frame.report.replayedEpisodes,
        abstracted: frame.report.abstractions,
        skills: frame.report.skillsFormed,
        merged: frame.report.mergedCount,
        faded: frame.report.fadedCount,
      }));
      clearTimeout(timeout);
      log('E2E PASS');
      process.exit(0);
      break;
    default:
      break;
  }
};

ws.onerror = (err) => {
  console.error('[e2e] ws error', err.message ?? err);
  process.exit(1);
};
