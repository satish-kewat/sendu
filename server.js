// server.js - final stable version for one-time tokens + reveal flow
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

wss.on('connection', (ws) => {
    console.log('New client connected');
    clients.add(ws);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type);

            switch (data.type) {
                case 'offer':
                    ws.send(JSON.stringify({
                        type: 'offer-created',
                        offer: data.offer
                    }));
                    break;

                case 'answer':
                    ws.send(JSON.stringify({
                        type: 'answer-created',
                        answer: data.answer
                    }));
                    break;

                case 'ice-candidate':
                    clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'ice-candidate',
                                candidate: data.candidate
                            }));
                        }
                    });
                    break;

                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        clients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });

    // Welcome
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to signaling server'
    }));
});

// Health
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        clients: clients.size,
        timestamp: new Date().toISOString()
    });
});

// Store token endpoint -> returns id
app.post('/store', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const id = uuidv4();
    tokens.set(id, token);
    // automatic cleanup after TTL to keep memory low
    setTimeout(() => tokens.delete(id), 10 * 60 * 1000);
    res.json({ id });
});

// Serve the short token page (does NOT consume the token).
// Visiting this page shows a "Reveal" button — token will be consumed only when the user taps Reveal.
app.get('/t/:id', (req, res) => {
    const id = req.params.id;
    const token = tokens.get(id);

    if (!token) {
        return res.status(404).send(`
            <html><body style="font-family:sans-serif;padding:20px;">
                <h2>❌ Token expired or already used</h2>
                <p>This token can only be used once or has expired.</p>
            </body></html>
        `);
    }

    // Send a mobile-friendly page that will call /consume/:id when user clicks Reveal
    res.send(`
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1">
          <title>P2P Token</title>
          <style>
            body{font-family:Arial, Helvetica, sans-serif;padding:20px}
            .btn{display:inline-block;padding:12px 16px;border-radius:8px;border:none;font-size:16px;margin:6px 0}
            .btn-primary{background:#0275d8;color:#fff}
            .btn-ghost{background:#f1f1f1}
            textarea{width:100%;height:150px;padding:10px;border-radius:8px;border:1px solid #ddd}
          </style>
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
                area.innerHTML = 
                  '<textarea id="tok">'+ j.token +'</textarea>' +
                  '<br><br>' +
                  '<button class="btn btn-ghost" onclick="copyToken()">Copy</button> ' +
                  '<button class="btn btn-primary" onclick="openApp()">Send to App</button>';
              } catch (err) {
                showExpired();
              }
            }
            function showExpired(){
              document.body.innerHTML = '<h2>❌ Token expired or already used</h2><p>This token was already used or expired.</p>';
            }
            function copyToken(){
              const t = document.getElementById('tok');
              t.select();
              document.execCommand('copy');
              alert('Copied to clipboard');
            }
            function openApp(){
              const t = encodeURIComponent(document.getElementById('tok').value);
              // Redirect to app homepage with token param
              window.location.href = '/?token=' + t;
            }
          </script>
        </body>
        </html>
    `);
});

// Consume route — when mobile user explicitly taps Reveal this is called; token is deleted here (one-time).
app.get('/consume/:id', (req, res) => {
    const id = req.params.id;
    const token = tokens.get(id);

    if (!token) return res.json({ error: 'expired' });

    // Delete now (one-time use)
    tokens.delete(id);

    res.json({ token });
});

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`WebSocket running at ws://localhost:${PORT}`);
});

// graceful shutdown
process.on('SIGINT', () => {
    console.log('SIGINT -> shutting down');
    server.close(() => process.exit(0));
});
