// server.js - hardened for Render + better logging
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory token store (id -> token string). Small, ephemeral.
const tokens = new Map();

// Store connected clients
const clients = new Set();

// TTL for tokens (ms)
const TOKEN_TTL = 10 * 60 * 1000; // 10 minutes

// ---- WebSocket handlers ----
wss.on('connection', (ws, req) => {
  console.log('New client connected:', req && req.socket ? req.socket.remoteAddress : 'unknown');
  clients.add(ws);

  ws.on('message', (message) => {
    try {
      // message may be string or Buffer
      const txt = typeof message === 'string' ? message : message.toString();
      const data = JSON.parse(txt);
      console.log('Received message type:', data.type);

      switch (data.type) {
        case 'offer':
          ws.send(JSON.stringify({ type: 'offer-created', offer: data.offer }));
          break;
        case 'answer':
          ws.send(JSON.stringify({ type: 'answer-created', answer: data.answer }));
          break;
        case 'ice-candidate':
          clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ type: 'ice-candidate', candidate: data.candidate }));
            }
          });
          break;
        default:
          console.log('Unknown message type:', data.type);
      }
    } catch (err) {
      console.error('Error handling ws message:', err && err.stack ? err.stack : err);
      // optional: notify the client
      try { ws.send(JSON.stringify({ type: 'error', message: 'invalid message' })); } catch(e){/* ignore */ }
    }
  });

  ws.on('close', (code, reason) => {
    console.log('Client disconnected. code=', code, 'reason=', reason && reason.toString ? reason.toString() : reason);
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error (client):', error && error.stack ? error.stack : error);
    clients.delete(ws);
  });

  // send welcome if open
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'connected', message: 'Connected to signaling server' }));
    } catch (e) { /* ignore */ }
  }
});

// surface server-level errors
server.on('error', (err) => {
  console.error('HTTP server error:', err && err.stack ? err.stack : err);
});
wss.on('error', (err) => {
  console.error('WSS server error:', err && err.stack ? err.stack : err);
});

// ---- HTTP routes ----
app.get('/health', (req, res) => {
  res.json({ status: 'ok', clients: clients.size, timestamp: new Date().toISOString() });
});

app.post('/store', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  const id = uuidv4();
  tokens.set(id, token);
  setTimeout(() => tokens.delete(id), TOKEN_TTL);
  res.json({ id });
});

app.get('/t/:id', (req, res) => {
  const id = req.params.id;
  const token = tokens.get(id);
  if (!token) {
    return res.status(404).send(`<html><body style="font-family:sans-serif;padding:20px;"><h2>❌ Token expired or already used</h2><p>This token can only be used once or has expired.</p></body></html>`);
  }
  res.send(`<!doctype html>
    <html>
    <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>P2P Token</title>
    <style>body{font-family:Arial, Helvetica, sans-serif;padding:20px}.btn{display:inline-block;padding:12px 16px;border-radius:8px;border:none;font-size:16px;margin:6px 0}.btn-primary{background:#0275d8;color:#fff}.btn-ghost{background:#f1f1f1}textarea{width:100%;height:150px;padding:10px;border-radius:8px;border:1px solid #ddd}</style>
    </head>
    <body>
      <h2>📡 P2P Connection Token</h2>
      <p>Tap <strong>Reveal</strong> to show and copy the token (it will be used only once).</p>
      <button class="btn btn-primary" onclick="reveal()">Reveal Token</button>
      <div id="area" style="margin-top:18px;display:none"></div>
      <script>
        async function reveal() {
          try {
            const r = await fetch('/consume/${id}');
            const j = await r.json();
            if (j.error) return showExpired();
            const area = document.getElementById('area');
            area.style.display = 'block';
            area.innerHTML = '<textarea id="tok">'+ j.token +'</textarea><br><br><button class="btn btn-ghost" onclick="copyToken()">Copy</button> <button class="btn btn-primary" onclick="openApp()">Send to App</button>';
          } catch (err) { showExpired(); }
        }
        function showExpired(){ document.body.innerHTML = '<h2>❌ Token expired or already used</h2><p>This token was already used or expired.</p>'; }
        function copyToken(){ const t = document.getElementById('tok'); t.select(); document.execCommand('copy'); alert('Copied to clipboard'); }
        function openApp(){ const t = encodeURIComponent(document.getElementById('tok').value); window.location.href = '/?token=' + t; }
      </script>
    </body></html>`);
});

app.get('/consume/:id', (req, res) => {
  const id = req.params.id;
  const token = tokens.get(id);
  if (!token) return res.json({ error: 'expired' });
  tokens.delete(id);
  res.json({ token });
});

// ---- start server ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  // Build friendly public URLs if provided by Render or environment
  const renderUrl = process.env.RENDER_EXTERNAL_URL || process.env.HOSTNAME || null;
  let publicHttp = null, publicWs = null;
  if (renderUrl) {
    const normalized = renderUrl.startsWith('http') ? renderUrl : `https://${renderUrl}`;
    try {
      const u = new URL(normalized);
      publicHttp = u.href.replace(/\/$/, '');
      publicWs = `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}`;
    } catch (e) {
      publicHttp = normalized;
      publicWs = normalized.startsWith('https') ? `wss://${renderUrl}` : `ws://${renderUrl}`;
    }
  }

  console.log(`Server listening on port ${PORT}`);
  if (publicHttp && publicWs) {
    console.log(`Public HTTP: ${publicHttp}`);
    console.log(`Public WebSocket (use wss if site is https): ${publicWs}`);
  } else {
    console.log('Public URL not detected in env; use the site URL shown in your host (Render) dashboard.');
  }
  console.log(`Connected clients: ${clients.size}`);
});

// graceful shutdown
const shutdown = () => {
  console.log('Shutdown initiated');
  try {
    wss.clients.forEach((c) => { try { c.terminate(); } catch(e){} });
    wss.close(() => console.log('wss closed'));
  } catch (e) { /* ignore */ }
  server.close(() => {
    console.log('http server closed');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// crash reporting hooks (prints stack traces)
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
  // Optionally exit: process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
