const express = require('express');
const cors = require('cors');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { rmSync } = require('fs');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys");

const app = express();
app.use(cors());
app.use(express.json());

// Serve static frontend files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8000;

// Memory cache to hold completed session data for the frontend polling endpoint
const completedSessions = {};

// Request Pairing Code Endpoint
app.post('/api/get-code', async (req, res) => {
    let { num } = req.body;
    if (!num) return res.status(400).json({ error: "Phone number is required." });

    const phoneNumber = num.replace(/[^0-9]/g, '');
    const requestId = `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const sessionDir = path.join(__dirname, 'temp_sessions', requestId);

    try {
        let { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (connection === 'open') {
                try {
                    const credsFilePath = path.join(sessionDir, 'creds.json');
                    if (fs.existsSync(credsFilePath)) {
                        const credsData = fs.readFileSync(credsFilePath, 'utf-8');
                        // Encode the credentials to standard Base64 matching your format
                        const base64Session = Buffer.from(credsData).toString('base64');
                        const finalSessionId = `XPLOADER-BOT:~${base64Session}`;

                        // Store in cache immediately so frontend polling catches it
                        completedSessions[requestId] = { status: 'completed', sessionId: finalSessionId };

                        // Direct message the generated Session ID to the newly linked account
                        const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        await sock.sendMessage(botNumber, {
                            text: `🤖 *JOKER-MD SESSION ID GENERATED* 🤖\n\nKeep this string completely private!\n\n\`\`\`${finalSessionId}\`\`\``
                        });
                    }
                } catch (err) {
                    console.error("Session generation error:", err);
                    completedSessions[requestId] = { status: 'error' };
                } finally {
                    await delay(5000);
                    try { sock.logout(); } catch {}
                    try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
                }
            }
        });

        // Request pairing code after the socket is established
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                res.status(200).json({ success: true, code, requestId });
            } catch (err) {
                res.status(500).json({ error: "Failed to fetch pairing code. Ensure the number has a country code." });
                try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
            }
        }, 3000);

    } catch (error) {
        res.status(500).json({ error: "Internal server error starting the process." });
        try { rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
});

// Endpoint to check link status and fetch Session ID
app.get('/api/check-session/:requestId', (req, res) => {
    const { requestId } = req.params;

    if (completedSessions[requestId]) {
        const sessionData = completedSessions[requestId];
        if (sessionData.status === 'completed' || sessionData.status === 'error') {
            setTimeout(() => { delete completedSessions[requestId]; }, 15000);
        }
        return res.status(200).json(sessionData);
    }

    const sessionDir = path.join(__dirname, 'temp_sessions', requestId);
    if (fs.existsSync(sessionDir)) {
        return res.status(200).json({ status: "pending" });
    }
    
    return res.status(404).json({ status: "expired" });
});

app.listen(PORT, () => {
    console.log(`🚀 Joker Web Pairing Server running on port ${PORT}`);
});
