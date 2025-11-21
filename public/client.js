// client.js - final stable version (place under public/)
(function(){
    const urlParams = new URLSearchParams(window.location.search);
    const autoToken = urlParams.get('token');
    if (autoToken) {
        setTimeout(() => autoHandleToken(autoToken), 300);
    }
})();

// WebSocket - use ws/wss automatically based on page protocol and host
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${location.host}/`);

// STUN config
const configuration = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
]};

let peerConnection = null;
let dataChannel = null;
let selectedFiles = [];
let isInitiator = false;
let qrCodeInstance = null;

// DOM
const fileInput = document.getElementById('fileInput');
const shareBtn = document.getElementById('shareBtn');
const createConnectionBtn = document.getElementById('createConnectionBtn');
const scanOfferBtn = document.getElementById('scanOfferBtn');
const tokenInput = document.getElementById('tokenInput');
const copyBtn = document.getElementById('copyBtn');
const statusMessage = document.getElementById('statusMessage');
const answerSection = document.getElementById('answerSection');
const answerInput = document.getElementById('answerInput');
const connectBtn = document.getElementById('connectBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const fileInfo = document.getElementById('fileInfo');

// disable until ready
fileInput.disabled = true;
shareBtn.disabled = true;

function waitForIceGatheringComplete(pc, timeout = 3000) {
    return new Promise((resolve) => {
        if (!pc) return resolve();
        if (pc.iceGatheringState === 'complete') return resolve();
        const handler = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', handler); resolve(); } };
        pc.addEventListener('icegatheringstatechange', handler);
        setTimeout(() => { try { pc.removeEventListener('icegatheringstatechange', handler); } catch{}; resolve(); }, timeout);
    });
}

// store token => short url
async function storeTokenAndGetShortUrl(tokenString) {
    const resp = await fetch('/store', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token: tokenString })
    });
    if (!resp.ok) throw new Error('store failed');
    const { id } = await resp.json();
    return `${location.origin}/t/${id}`;
}

// file change
fileInput.addEventListener('change', (e) => {
    selectedFiles = Array.from(e.target.files);
    if (selectedFiles.length) {
        let info = `Selected ${selectedFiles.length} file(s):<br>`;
        selectedFiles.forEach(f => info += `• ${f.name} (${formatFileSize(f.size)})<br>`);
        fileInfo.innerHTML = info;
        fileInfo.style.display = 'block';
        showStatus('Files selected (ready to send)', 'success');
    }
});

// Create Connection (initiator)
createConnectionBtn.addEventListener('click', async () => {
    if (ws.readyState !== WebSocket.OPEN) { showStatus('Signaling not connected', 'error'); return; }
    isInitiator = true;
    await createPeerConnection();
    dataChannel = peerConnection.createDataChannel('fileTransfer');
    setupDataChannel();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);

    ws.send(JSON.stringify({ type: 'offer', offer: peerConnection.localDescription }));
    showStatus('Offer created — short URL will be generated', 'info');
});

// ws messages
ws.onmessage = async (evt) => {
    const data = JSON.parse(evt.data);

    if (data.type === 'offer-created') {
        const offerToken = JSON.stringify(data.offer);
        try {
            const short = await storeTokenAndGetShortUrl(offerToken);
            tokenInput.value = short;
            generateQRCode(short, 128);
            answerSection.style.display = 'block';
            showStatus('Offer short URL created. Share the QR.', 'info');
        } catch (err) {
            tokenInput.value = offerToken;
            generateQRCode(offerToken, 256);
            showStatus('Failed to shorten token — showing full token', 'error');
        }
        return;
    }

    if (data.type === 'answer-created') {
        const answerToken = JSON.stringify(data.answer);
        try {
            const short = await storeTokenAndGetShortUrl(answerToken);
            tokenInput.value = short;
            generateQRCode(short, 128);
            showStatus('Answer short URL created. Send to initiator.', 'success');
        } catch {
            tokenInput.value = answerToken;
            generateQRCode(answerToken, 256);
            showStatus('Failed to shorten token — showing full token', 'error');
        }
        return;
    }

    if (data.type === 'ice-candidate' && peerConnection) {
        try { await peerConnection.addIceCandidate(data.candidate); } catch (e) { console.error(e); }
    }
};

// helpful ws handlers for debugging
ws.onopen = () => {
    console.log('WebSocket open to', `${protocol}://${location.host}/`);
    showStatus('Signaling server connected', 'success');
};
ws.onerror = (e) => {
    console.error('WebSocket error', e);
    showStatus('Signaling connection error', 'error');
};
ws.onclose = () => {
    console.log('WebSocket closed');
    showStatus('Signaling connection closed', 'info');
};

// ICE handler
function setupIceCandidateHandler() {
    peerConnection.onicecandidate = (ev) => {
        if (ev.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: ev.candidate }));
    };
}

// manual scan handler
scanOfferBtn.addEventListener('click', async () => {
    const txt = prompt('Paste the offer token or short URL you scanned:');
    if (!txt) return;
    await handleScannedOrPastedToken(txt);
});

async function handleScannedOrPastedToken(tokenOrUrl) {
    try {
        let text = tokenOrUrl.trim();
        try {
            const url = new URL(text, location.origin);
            if (url.pathname.startsWith('/t/')) {
                const resp = await fetch(url.href);
                if (!resp.ok) throw new Error('Failed to fetch token');
                text = await resp.text();
            }
        } catch {}
        const obj = JSON.parse(text);
        if (obj.type !== 'offer') { showStatus('Invalid offer token', 'error'); return; }

        isInitiator = false;
        await createPeerConnection();
        await peerConnection.setRemoteDescription(obj);

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        await waitForIceGatheringComplete(peerConnection);

        ws.send(JSON.stringify({ type: 'answer', answer: peerConnection.localDescription }));
        showStatus('Answer created. Share with initiator.', 'info');
    } catch (err) {
        showStatus('Error processing token: ' + err.message, 'error');
    }
}

// auto-flow: handle token passed via URL param
async function autoHandleToken(tokenText) {
    let decoded = tokenText;
    try { decoded = decodeURIComponent(tokenText); } catch {}
    try {
        const maybeUrl = new URL(decoded, location.origin);
        if (maybeUrl.pathname.startsWith('/t/')) {
            const resp = await fetch(maybeUrl.href);
            if (!resp.ok) throw new Error('Failed to fetch token');
            decoded = await resp.text();
        }
    } catch {}
    try {
        const obj = JSON.parse(decoded);
        if (obj.type === 'offer') {
            await handleScannedOrPastedToken(decoded); // receiver auto
        } else if (obj.type === 'answer') {
            answerInput.value = decoded;
            connectBtn.click();
        }
    } catch (err) { console.error('autoHandle parse error', err); }
}

// Connect button
connectBtn.addEventListener('click', async () => {
    let answerText = answerInput.value.trim();
    if (!answerText) { showStatus('Please paste answer token', 'error'); return; }
    try {
        try {
            const url = new URL(answerText, location.origin);
            if (url.pathname.startsWith('/t/')) {
                const resp = await fetch(url.href);
                if (!resp.ok) throw new Error('Failed to fetch token');
                answerText = await resp.text();
            }
        } catch {}
        const answerData = JSON.parse(answerText);
        if (answerData.type !== 'answer') { showStatus('Invalid answer token', 'error'); return; }
        await peerConnection.setRemoteDescription(answerData);
        showStatus('Connection established! You can choose files and send.', 'success');
        fileInput.disabled = false;
        if (dataChannel && dataChannel.readyState === 'open') shareBtn.disabled = false;
    } catch (err) {
        showStatus('Error connecting: ' + err.message, 'error');
    }
});

// Create peer connection
async function createPeerConnection() {
    peerConnection = new RTCPeerConnection(configuration);
    setupIceCandidateHandler();
    peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') showStatus('Peer connected!', 'success');
    };
    peerConnection.ondatachannel = (ev) => { dataChannel = ev.channel; setupDataChannel(); };
}

// Data channel setup
function setupDataChannel() {
    dataChannel.onopen = () => { showStatus('Data channel open', 'success'); fileInput.disabled = false; shareBtn.disabled = false; };
    dataChannel.onclose = () => { showStatus('Data channel closed', 'info'); shareBtn.disabled = true; fileInput.disabled = true; };
    dataChannel.onmessage = receiveFile;
}

// File transfer (same chunking)
let currentFile = null, fileReader = null, offset = 0;
const chunkSize = 16384;

shareBtn.addEventListener('click', () => {
    if (!dataChannel || dataChannel.readyState !== 'open') { showStatus('Establish connection first', 'error'); return; }
    if (!selectedFiles.length) { showStatus('Select a file', 'error'); return; }
    sendFiles();
});

function sendFiles() {
    currentFile = selectedFiles[0]; offset = 0;
    const metadata = { type: 'metadata', name: currentFile.name, size: currentFile.size, fileType: currentFile.type };
    dataChannel.send(JSON.stringify(metadata));
    fileReader = new FileReader();
    fileReader.onload = (e) => {
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        updateProgress((offset / currentFile.size) * 100);
        if (offset < currentFile.size) readSlice(offset);
        else { showStatus('File sent!', 'success'); progressContainer.style.display = 'none'; }
    };
    progressContainer.style.display = 'block';
    readSlice(0);
}
function readSlice(o) { const slice = currentFile.slice(o, o + chunkSize); fileReader.readAsArrayBuffer(slice); }

let receivedSize = 0, receivedChunks = [], fileMetadata = null;
function receiveFile(ev) {
    if (typeof ev.data === 'string') {
        fileMetadata = JSON.parse(ev.data); receivedSize = 0; receivedChunks = [];
        progressContainer.style.display = 'block'; showStatus('Receiving '+fileMetadata.name, 'info');
    } else {
        receivedChunks.push(ev.data); receivedSize += ev.data.byteLength;
        updateProgress((receivedSize / fileMetadata.size) * 100);
        if (receivedSize === fileMetadata.size) {
            const blob = new Blob(receivedChunks, { type: fileMetadata.fileType });
            downloadFile(blob, fileMetadata.name);
            progressContainer.style.display = 'none';
            showStatus('File received!', 'success');
        }
    }
}
function downloadFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

// Copy button
copyBtn.addEventListener('click', () => { navigator.clipboard.writeText(tokenInput.value); showStatus('Token copied!', 'success'); });

// QR generator — uses the short URL or text directly, but does NOT make it clickable
function generateQRCode(text, size = 256) {
    const qrcodeDiv = document.getElementById('qrcode');
    qrcodeDiv.innerHTML = '';
    // If it's a local short URL, convert to absolute so scanners open the right page
    let qrText = text;
    try { const maybe = new URL(text, location.origin); qrText = maybe.href; } catch {}
    qrCodeInstance = new QRCode(qrcodeDiv, { text: qrText, width: size, height: size, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.H });
}

// helpers
function updateProgress(p) { const r = Math.round(p); progressBar.style.width = r + '%'; progressBar.textContent = r + '%'; }
function showStatus(msg, type) { statusMessage.textContent = msg; statusMessage.className = 'status-message status-' + type; statusMessage.style.display = 'block'; if (type === 'success' || type === 'error') setTimeout(()=>statusMessage.style.display='none',5000); }
function formatFileSize(bytes) { if (!bytes) return '0 Bytes'; const k = 1024; const sizes = ['Bytes','KB','MB','GB']; const i = Math.floor(Math.log(bytes)/Math.log(k)); return Math.round(bytes/Math.pow(k,i)*100)/100 + ' ' + sizes[i]; }
