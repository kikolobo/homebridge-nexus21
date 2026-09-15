#!/usr/bin/env node
// Test tool for the Nexus 21 IP module (IPLIN REST API v1.0).
//
//   node tools/probe.mjs discover                 SSDP search, lists modules
//   node tools/probe.mjs <host> status            GET /api/status
//   node tools/probe.mjs <host> UP|DOWN|MEM1|MEM2|MEM3
//   node tools/probe.mjs <host> watch             prints every status change (try the RF remote)
//   node tools/probe.mjs ws://<host>/<path>       prints websocket feedback (run npm install first)
import dgram from 'node:dgram';

const [target, action = 'status'] = process.argv.slice(2);
if (!target) {
  console.log('usage: probe.mjs discover | <host> status|watch|UP|DOWN|MEM1|MEM2|MEM3 | ws://host/path');
  process.exit(1);
}

if (target === 'discover') {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: urn:Nexus21:service:basicevent:1\r\n\r\n');
  sock.on('message', (buf, rinfo) => console.log(`--- ${rinfo.address}\n${buf.toString().trim()}\n`));
  sock.bind(0, () => {
    sock.send(msg, 1900, '239.255.255.250');
    setTimeout(() => sock.send(msg, 1900, '239.255.255.250'), 500);
    setTimeout(() => { sock.close(); console.log('done'); }, 3000);
  });
} else if (target.startsWith('ws://') || target.startsWith('wss://')) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(target);
  ws.on('open', () => console.log(`connected ${target}`));
  ws.on('message', (d) => console.log(new Date().toISOString(), d.toString()));
  ws.on('close', (code) => { console.log(`closed (${code})`); process.exit(0); });
  ws.on('error', (e) => console.error(`error: ${e.message}`));
} else {
  const base = target.startsWith('http') ? target : `http://${target}`;
  const status = async () => (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(4000) })).text();

  if (action === 'status') {
    console.log(await status());
  } else if (action === 'watch') {
    let last = '';
    console.log('watching (Ctrl+C to quit)…');
    for (;;) {
      try {
        const s = await status();
        if (s !== last) console.log(new Date().toISOString(), s);
        last = s;
      } catch (e) {
        console.log(new Date().toISOString(), `error: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } else {
    const cmd = action.toUpperCase();
    const res = await fetch(`${base}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ COMMAND: cmd }),
      signal: AbortSignal.timeout(4000),
    });
    console.log(`${cmd} → HTTP ${res.status} ${await res.text()}`);
  }
}
