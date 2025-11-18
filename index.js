const express = require('express');

const bodyParser = require('body-parser');

const path = require('path');

const fs = require('fs');

const multer = require('multer');

const app = express();
app.use(express.static(path.join(__dirname, "public/uploads")))

app.use(bodyParser.urlencoded({ extended: false }));

app.use(bodyParser.json());

//Disk Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads');
    },
    filename: function (req, file, cb) {
        cb(
            null,
            file.fieldname + "-" + Date.now() + path.extname(file.originalname)
        );
    }
});

let upload = multer({ storage: storage }).single('file');


//view engine ejs
app.set('view engine', 'ejs');

//open homepage
app.get('/', (req, res) => {
    res.render('index');
});

app.post('/uploadfile', (req, res) => {
    upload(req, res, (err) => {
        if (err) {
            console.log(err)
        } else {
            console.log(req.file.path);
            res.json({
                path: req.file.filename
            })
        }
    })
})

// ---- temporary in-memory signaling store (very small, for QR-token method) ----
const crypto = require('crypto');
const SIGNAL_STORE = new Map(); // token -> { sdp, expireTimeout }

// POST /signal  { sdp: "..." }  -> returns { token: "abc123" }
app.post('/signal', express.json(), (req, res) => {
  const { sdp } = req.body || {};
  if (!sdp) return res.status(400).json({ error: 'missing sdp' });

  const token = crypto.randomBytes(6).toString('base64url'); // short url-safe id
  // store and auto-expire after 2 minutes
  if (SIGNAL_STORE.has(token)) SIGNAL_STORE.delete(token);
  const timeout = setTimeout(() => { SIGNAL_STORE.delete(token); }, 2 * 60 * 1000);
  SIGNAL_STORE.set(token, { sdp, timeout });

  res.json({ token });
});

// GET /signal/:token  -> returns { sdp: "..." } or 404
app.get('/signal/:token', (req, res) => {
  const token = req.params.token;
  const entry = SIGNAL_STORE.get(token);
  if (!entry) return res.status(404).json({ error: 'not found or expired' });
  // optionally delete immediately so token is one-time use
  clearTimeout(entry.timeout);
  SIGNAL_STORE.delete(token);
  res.json({ sdp: entry.sdp });
});


//get request to download.

app.get('/files/:id', (req, res) => {
    console.log(req.params.id);

    res.render('displayfile', { path: req.params.id })
})

app.get('/download', (req, res) => {
    let pathoutput = req.query.path;
    console.log(pathoutput);
    let fullPath = path.join(__dirname, pathoutput);
    res.download(fullPath, (err) => {
        if (err) {
            res.send(err);
        }
    });

})



const PORT = process.env.PORT || 5000

app.listen(PORT, () => {
    console.log("app is lissting")
})