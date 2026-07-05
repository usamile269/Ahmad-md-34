const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    Browsers,
    DisconnectReason,
    jidDecode,
    downloadContentFromMessage,
    getContentType,
} = require('@whiskeysockets/baileys');
const config = require('./config');
const events = require('./zaidi');
const { sms } = require('./lib/msg');
const {
    connectdb,
    saveSessionToMongoDB,
    getSessionFromMongoDB,
    deleteSessionFromMongoDB,
    getUserConfigFromMongoDB,
    updateUserConfigInMongoDB,
    addNumberToMongoDB,
    removeNumberFromMongoDB,
    getAllNumbersFromMongoDB,
    saveOTPToMongoDB,
    verifyOTPFromMongoDB,
    incrementStats,
    getStatsForNumber
} = require('./lib/database');
const { handleAntidelete, handleAntideleteUpsert } = require('./lib/antidelete');
const { handleAntieditUpsert } = require('./lib/antiedit');
const { handleAntiViewOnce } = require('./lib/viewonce-capture');

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const crypto = require('crypto');
const FileType = require('file-type');
const axios = require('axios');
const moment = require('moment-timezone');

const prefix = config.PREFIX;
const mode = config.MODE || config.WORK_TYPE;
const router = express.Router();


connectdb();

const activeSockets = new Map();
const socketCreationTime = new Map();
const channelWatchers = new Map(); // number -> setInterval id, for periodic re-follow
const lastCommandAt = new Map(); // "botNumber:sender" -> timestamp, for CMD_COOLDOWN enforcement


function createzaidiStore() {
    const store = {
        messages: {},
        bind(ev) {
            ev.on('messages.upsert', ({ messages }) => {
                for (const msg of messages) {
                    const jid = msg.key && msg.key.remoteJid;
                    if (!jid) continue;
                    if (!store.messages[jid]) store.messages[jid] = [];
                    store.messages[jid].push(msg);
                    if (store.messages[jid].length > 200) store.messages[jid].shift();
                }
            });
        },
        async loadMessage(jid, id) {
            if (!store.messages[jid]) return null;
            return store.messages[jid].find(m => m.key && m.key.id === id) || null;
        }
    };
    return store;
}

// Utility functions
const createSerial = (size) => crypto.randomBytes(size).toString('hex').slice(0, size);

// ✅ FIX (GCSTATUS-FIX): WhatsApp now assigns group participants a privacy
// "@lid" identity in addition to their real "@s.whatsapp.net" number. If a
// group uses @lid internally, groupMetadata.participants[i].id will be an
// @lid jid, while the sender of a message may show up as either @lid or
// @s.whatsapp.net depending on context. Comparing only the numeric part of
// two different jid *types* will never match, so a real admin was wrongly
// told "you must be admin". Fix: collect every identity field Baileys may
// expose per participant, and normalize/compare against ALL of them.
const getGroupAdmins = (participants) => {
    let admins = [];
    for (let i of participants) {
        if (i.admin == null) continue; // not an admin/superadmin
        if (i.id) admins.push(i.id);
        if (i.jid) admins.push(i.jid);
        if (i.lid) admins.push(i.lid);
        if (i.phoneNumber) admins.push(i.phoneNumber);
    }
    return admins;
};

const isJidInList = (jid, list) => {
    if (!jid || !list) return false;
    const num = jid.split('@')[0].split(':')[0];
    return list.some(item => item && item.split('@')[0].split(':')[0] === num);
};

// Extra safety net: if the plain numeric comparison above still fails
// (e.g. sender is @lid but admin list only has the @s.whatsapp.net number,
// or vice versa), ask Baileys' own lid<->phone-number mapping store to
// resolve the alternate identity and try again. Wrapped in try/catch
// because this internal API can vary between Baileys versions.
const resolveIsAdmin = async (conn, jid, list) => {
    if (isJidInList(jid, list)) return true;
    try {
        const isLid = jid.endsWith('@lid');
        const lidMap = conn?.signalRepository?.lidMapping;
        if (lidMap) {
            const alt = isLid
                ? await lidMap.getPNForLID(jid)
                : await lidMap.getLIDForPN(jid);
            if (alt && isJidInList(alt, list)) return true;
        }
    } catch (_) {}
    return false;
};

function isNumberAlreadyConnected(number) {
    return activeSockets.has(number.replace(/[^0-9]/g, ''));
}

function getConnectionStatus(number) {
    const n = number.replace(/[^0-9]/g, '');
    const isConnected = activeSockets.has(n);
    const connectionTime = socketCreationTime.get(n);
    return {
        isConnected,
        connectionTime: connectionTime ? new Date(connectionTime).toLocaleString() : null,
        uptime: connectionTime ? Math.floor((Date.now() - connectionTime) / 1000) : 0
    };
}

function zaidiLog(message, type = 'info') {
    const icons = { info: '📝', success: '✅', error: '❌', warning: '⚠️', debug: '🐛' };
    console.log(`${icons[type] || '📝'} [𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪] ${new Date().toISOString()}: ${message}`);
}

// Load Plugins
const pluginsDir = path.join(__dirname, 'plugins');
if (!fs.existsSync(pluginsDir)) fs.mkdirSync(pluginsDir, { recursive: true });
const pluginFiles = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js'));
zaidiLog(`Loading ${pluginFiles.length} plugins...`, 'info');
for (const file of pluginFiles) {
    try { require(path.join(pluginsDir, file)); }
    catch (e) { zaidiLog(`Failed to load plugin ${file}: ${e.message}`, 'error'); }
}


async function setupCallHandlers(socket, number) {
    socket.ev.on('call', async (calls) => {
        try {
            const userConfig = await getUserConfigFromMongoDB(number);
            if (userConfig.ANTI_CALL !== 'true') return;
            for (const call of calls) {
                if (call.status !== 'offer') continue;
                await socket.rejectCall(call.id, call.from);
                await socket.sendMessage(call.from, {
                    text: userConfig.REJECT_MSG || config.REJECT_MSG
                });
                zaidiLog(`Auto-rejected call for ${number} from ${call.from}`, 'info');
            }
        } catch (err) {
            zaidiLog(`Anti-call error for ${number}: ${err.message}`, 'error');
        }
    });
}

function setupAutoRestart(socket, number) {
    let restartAttempts = 0;
    const maxRestartAttempts = 8; // was 3 — too easy to exhaust and end up needing a manual reconnect

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
            const errorMessage = lastDisconnect && lastDisconnect.error && lastDisconnect.error.message;
            // Full disconnect reason logged every time — if the bot drops again,
            // this line tells us exactly why (e.g. was it WhatsApp closing the
            // stream, a timeout, a stream:error, etc).
            zaidiLog(`Connection closed for ${number}: statusCode=${statusCode} reason="${errorMessage}"`, 'warning');

            if (statusCode === 401 || (errorMessage && errorMessage.includes('401'))) {
                zaidiLog(`Manual unlink detected for ${number}, cleaning up...`, 'warning');
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                await deleteSessionFromMongoDB(sanitizedNumber);
                await removeNumberFromMongoDB(sanitizedNumber);
                socket.ev.removeAllListeners();
                return;
            }

            const isNormalError = statusCode === 408 || (errorMessage && errorMessage.includes('QR refs attempts ended'));
            if (isNormalError) { zaidiLog(`Normal closure for ${number}, no restart needed.`, 'info'); return; }

            if (restartAttempts < maxRestartAttempts) {
                restartAttempts++;
                // 515 = restartRequired — Baileys expects an IMMEDIATE reconnect
                // here (it's a normal part of the connection handshake, not a
                // real failure), so don't sit through the usual 10s delay for it.
                const isRestartRequired = statusCode === 515;
                const waitMs = isRestartRequired ? 500 : 10000;
                zaidiLog(`Reconnecting ${number} (${restartAttempts}/${maxRestartAttempts}) in ${waitMs}ms...`, 'warning');
                const sanitizedNumber = number.replace(/[^0-9]/g, '');
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                socket.ev.removeAllListeners();
                await delay(waitMs);
                try {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes, setHeader: () => {}, json: () => {} };
                    await zaidiPair(number, mockRes);
                } catch (e) { zaidiLog(`Reconnection failed for ${number}: ${e.message}`, 'error'); }
            } else {
                zaidiLog(`Max restart attempts reached for ${number}. Manual reconnect needed.`, 'error');
            }
        }
        if (connection === 'open') { restartAttempts = 0; }
    });
}


async function zaidiPair(number, res = null) {
    let connectionLockKey;
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    try {
        const sessionPath = path.join(__dirname, 'session', `session_${sanitizedNumber}`);

        if (isNumberAlreadyConnected(sanitizedNumber)) {
            const status = getConnectionStatus(sanitizedNumber);
            if (res && !res.headersSent) {
                return res.json({ status: 'already_connected', message: 'Number is already connected', connectionTime: status.connectionTime, uptime: `${status.uptime} seconds` });
            }
            return;
        }

        connectionLockKey = `zaidi_lock_${sanitizedNumber}`;
        if (global[connectionLockKey]) {
            if (res && !res.headersSent) return res.json({ status: 'connection_in_progress' });
            return;
        }
        global[connectionLockKey] = true;

        // Check MongoDB session
        const existingSession = await getSessionFromMongoDB(sanitizedNumber);

        if (!existingSession) {
            zaidiLog(`No MongoDB session for ${sanitizedNumber} — new pairing required`, 'info');
            if (fs.existsSync(sessionPath)) {
                await fs.remove(sessionPath);
                zaidiLog(`Cleaned leftover local session for ${sanitizedNumber}`, 'info');
            }
        } else {
            // Session exists - restore from MongoDB
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(existingSession, null, 2));
            zaidiLog(`🔄 Restored existing session from MongoDB for ${sanitizedNumber}`, 'success');
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

        const zaidiStore = createzaidiStore();

        const conn = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger: pino({ level: "silent" }),
            version: [2, 3000, 9758746874],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            emitOwnEvents: true,
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            browser: ['Mac OS', 'Safari', '10.15.7'],
            getMessage: async (key) => {
                try {
                    const msg = await zaidiStore.loadMessage(key.remoteJid, key.id);
                    return msg && msg.message ? msg.message : undefined;
                } catch (e) {
                    return undefined;
                }
            }
        });

        socketCreationTime.set(sanitizedNumber, Date.now());
        activeSockets.set(sanitizedNumber, conn);
        zaidiStore.bind(conn.ev);

        // Setup handlers
        setupCallHandlers(conn, number);
        setupAutoRestart(conn, number);

        // decodeJid utility
        conn.decodeJid = jid => {
            if (!jid) return jid;
            if (/:\d+@/gi.test(jid)) {
                const decode = jidDecode(jid) || {};
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid;
            }
            return jid;
        };

        conn.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            const quoted = message.msg ? message.msg : message;
            const mime = (message.msg || message).mimetype || '';
            const messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            const type = await FileType.fromBuffer(buffer);
            const trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        // Pairing Code
        if (!conn.authState.creds.registered) {
            zaidiLog(`🔐 Starting NEW pairing process for ${sanitizedNumber}`, 'info');
            try {
                await delay(1500);
                const code = await conn.requestPairingCode(sanitizedNumber);
                zaidiLog(`Pairing Code for ${sanitizedNumber}: ${code}`, 'success');
                if (res && !res.headersSent) {
                    res.send({ code, status: 'new_pairing' });
                }
            } catch (error) {
                zaidiLog(`Failed to request pairing code: ${error.message}`, 'error');
                if (res && !res.headersSent) {
                    res.status(500).send({ error: 'Failed to get pairing code', status: 'error', message: error.message });
                }
                throw error;
            }
        } else {
            zaidiLog(`✅ Using existing session for ${sanitizedNumber}`, 'success');
            if (res && !res.headersSent) {
                res.json({ status: 'reconnecting', message: 'Reconnecting with existing session' });
            }
        }

        // Save creds on update
        conn.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const creds = JSON.parse(fileContent);
            const existingSessionCheck = await getSessionFromMongoDB(sanitizedNumber);
            const isNewSession = !existingSessionCheck;
            await saveSessionToMongoDB(sanitizedNumber, creds);
            if (isNewSession) {
                zaidiLog(`🎉 NEW user ${sanitizedNumber} successfully registered!`, 'success');
            }
        });

        // Anti-delete
        conn.ev.on('messages.update', async (updates) => {
            await handleAntidelete(conn, updates, zaidiStore);
        });

        // Connection update
        conn.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                zaidiLog(`Connected: ${sanitizedNumber}`, 'success');
                const userJid = jidNormalizedUser(conn.user.id);
                await addNumberToMongoDB(sanitizedNumber);

                // ✅ AUTO JOIN CHANNEL — har baar connect hone pe
                const channelLink = config.CHANNEL_LINK || '';
                async function ensureChannelFollowed() {
                    try {
                        if (channelLink && channelLink.includes('whatsapp.com/channel/')) {
                            const channelCode = channelLink.split('whatsapp.com/channel/')[1].split('?')[0];
                            const channelJid = channelCode + '@newsletter';
                            await conn.newsletterFollow(channelJid).catch(() => {});
                        }
                    } catch (autoJoinErr) {
                        zaidiLog('Channel auto-join skipped: ' + autoJoinErr.message, 'warning');
                    }
                }
                await ensureChannelFollowed();
                zaidiLog('✅ Auto-joined channel!', 'success');

                // 🚨 BUG FIX: the auto-join above only ran once, at connect time.
                // If someone unfollows the channel WHILE the bot stays connected
                // (no disconnect/reconnect happens), it stayed unfollowed until
                // the next reconnect. Now it's re-checked every 5 minutes so an
                // unfollow gets auto-corrected without needing a reconnect.
                if (channelWatchers.has(sanitizedNumber)) clearInterval(channelWatchers.get(sanitizedNumber));
                const watcherId = setInterval(ensureChannelFollowed, 5 * 60 * 1000);
                channelWatchers.set(sanitizedNumber, watcherId);

                if (!existingSession) {
                    await conn.sendMessage(userJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: `\n╭────────────────────◇\n│✦ *𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪 — CONNECTED* 🔥\n│✦ Type *${prefix}menu* to see all commands 💫\n│✦ Prefix 『 ${prefix} 』  Mode 〔${mode}〕\n╰────────────────────○\n*© Powered by 𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪*`
                    });
                }
            }
            if (connection === 'close') {
                if (channelWatchers.has(sanitizedNumber)) {
                    clearInterval(channelWatchers.get(sanitizedNumber));
                    channelWatchers.delete(sanitizedNumber);
                }
                const reason = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
                if (reason === DisconnectReason.loggedOut) zaidiLog(`Session logged out.`, 'error');
            }
        });


        conn.ev.on('messages.upsert', async (msg) => {
            try {
                // 🚨 BUG FIX (old commands "resending" themselves): Baileys emits
                // this event for BOTH brand-new realtime messages (type 'notify')
                // AND for messages replayed during a chat-history re-sync after a
                // reconnect (type 'append'/'prepend'). Without this check, every
                // reconnect (e.g. after any brief disconnect) caused old command
                // messages to be re-fed into the handler below, which re-ran the
                // matching command and re-sent its reply — looking like previously
                // used commands were firing again on their own.
                if (msg.type && msg.type !== 'notify') return;

                // Antidelete: modern WhatsApp usually reports "Delete for Everyone"
                // as a NEW message here (protocolMessage), not via messages.update.
                await handleAntideleteUpsert(conn, msg.messages, zaidiStore);
                await handleAntieditUpsert(conn, msg.messages, zaidiStore);
                for (const upsertMek of msg.messages) { await handleAntiViewOnce(conn, upsertMek); }

                let mek = msg.messages[0];
                if (!mek.message) return;
                // Self-bot: fromMe messages ARE owner commands, do not skip them

                const userConfig = await getUserConfigFromMongoDB(number);

                mek.message = (getContentType(mek.message) === 'ephemeralMessage')
                    ? mek.message.ephemeralMessage.message
                    : mek.message;

                if (userConfig.READ_MESSAGE === 'true') await conn.readMessages([mek.key]);

                // Newsletter reactions
                const newsletterJids = ['120363407376142647@newsletter'];
                const newsEmojis = ['❤️', '👍', '😮', '😎', '💀', '💫', '🔥', '👑'];
                if (mek.key && newsletterJids.includes(mek.key.remoteJid)) {
                    try {
                        const serverId = mek.newsletterServerId;
                        if (serverId) {
                            const emoji = newsEmojis[Math.floor(Math.random() * newsEmojis.length)];
                            await conn.newsletterReactMessage(mek.key.remoteJid, serverId.toString(), emoji);
                        }
                    } catch (_) {}
                }

                // Status handling
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    if (userConfig.AUTO_VIEW_STATUS === 'true') await conn.readMessages([mek.key]);
                    if (userConfig.AUTO_LIKE_STATUS === 'true') {
                        const botJid = await conn.decodeJid(conn.user.id);
                        const emojis = userConfig.AUTO_LIKE_EMOJI || config.AUTO_LIKE_EMOJI;
                        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                        await conn.sendMessage(mek.key.remoteJid, { react: { text: randomEmoji, key: mek.key } }, { statusJidList: [mek.key.participant, botJid] });
                    }
                    if (userConfig.AUTO_STATUS_REPLY === 'true') {
                        const user = mek.key.participant;
                        await conn.sendMessage(user, { text: userConfig.AUTO_STATUS_MSG || config.AUTO_STATUS_MSG }, { quoted: mek });
                    }
                    return;
                }

                const m = sms(conn, mek);
                const type = getContentType(mek.message);
                const from = mek.key.remoteJid;
                const body = (type === 'conversation') ? mek.message.conversation
                    : (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';

                const isCmd = body.startsWith(config.PREFIX);
                const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : '';
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                const text = q;
                const isGroup = from.endsWith('@g.us');

                // ✅ FIX: previously the code passed `quoted: mek` to every command,
                // which is the CURRENT incoming message, not the message being
                // replied to. That made `quoted.sender` resolve to the command
                // sender himself (so .kick removed the admin who typed it instead
                // of the replied person), and `quoted.key` point at the .del
                // command message itself (so .del deleted the wrong message).
                // Also `mentionedJid` was never provided at all, so @mention-based
                // targeting silently did nothing everywhere it was used.
                const mentionedJid = m.msg?.contextInfo?.mentionedJid || [];
                let quotedMsg = null;
                if (m.quoted && m.quoted.message) {
                    const qMsgType = getContentType(m.quoted.message);
                    quotedMsg = {
                        key: {
                            remoteJid: from,
                            id: m.quoted.stanzaId,
                            participant: m.quoted.participant,
                            fromMe: m.quoted.participant ? m.quoted.participant.split('@')[0] === conn.user.id.split(':')[0] : false
                        },
                        stanzaId: m.quoted.stanzaId,
                        message: m.quoted.message,
                        sender: m.quoted.participant,
                        mtype: qMsgType,
                        text: m.quoted.message?.conversation
                            || m.quoted.message?.extendedTextMessage?.text
                            || m.quoted.message?.imageMessage?.caption
                            || m.quoted.message?.videoMessage?.caption
                            || '',
                        download: async () => {
                            const content = m.quoted.message[qMsgType];
                            const mediaTypeMap = { imageMessage: 'image', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker' };
                            const stream = await downloadContentFromMessage(content, mediaTypeMap[qMsgType] || 'image');
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                            return buffer;
                        }
                    };
                    // keep m.quoted in sync so plugins reading m.quoted directly also benefit
                    m.quoted = quotedMsg;
                }

                const sender = mek.key.fromMe
                    ? (conn.user.id.split(':')[0] + '@s.whatsapp.net')
                    : (mek.key.participant || mek.key.remoteJid);
                const senderNumber = sender.split('@')[0];
                const botNumber = conn.user.id.split(':')[0];
                const botNumber2 = await jidNormalizedUser(conn.user.id);
                const pushname = mek.pushName || 'User';

                const isMe = botNumber === senderNumber;

                // ✅ OWNER CHECK — uses config.OWNER_NUMBER (settable, no code edit
                // needed) plus the bot's own number (covers "you messaging your
                // own bot" self-bot setups).
                // 🚨 BUG FIX: this used to compare senderNumber against a
                // HARDCODED placeholder number ("923044975027" — leftover
                // template default) instead of the actual configured owner.
                // Anyone whose real number wasn't that exact placeholder was
                // never recognized as owner — including the real bot owner —
                // which made .mode, .menu-in-other-chats (when WORK_TYPE is
                // "private"), and every other isOwner-gated command silently
                // fail for the actual owner.
                const ownerNumbers = (Array.isArray(config.OWNER_NUMBER)
                    ? config.OWNER_NUMBER
                    : [config.OWNER_NUMBER]
                ).map(n => String(n).replace(/[^0-9]/g, '').trim()).filter(Boolean);
                const isOwner = senderNumber === botNumber || ownerNumbers.includes(senderNumber);
                const isCreator = isOwner;

                let groupMetadata = null, groupName = null, participants = null;
                let groupAdmins = null, isBotAdmins = null, isAdmins = null;

                if (isGroup) {
                    try {
                        groupMetadata = await conn.groupMetadata(from);
                        groupName = groupMetadata.subject;
                        participants = groupMetadata.participants;
                        groupAdmins = getGroupAdmins(participants);
                        isBotAdmins = await resolveIsAdmin(conn, botNumber2, groupAdmins);
                        isAdmins = await resolveIsAdmin(conn, sender, groupAdmins);
                        // Temporary debug log — remove once confirmed fixed on your side.
                        // Shows exactly what jid was checked vs the admin list, so if
                        // it's still wrong you can see WHY (e.g. lid vs phone mismatch).
                        if (isCmd) {
                            console.log(`[ADMIN CHECK] sender=${sender} isAdmins=${isAdmins} | bot=${botNumber2} isBotAdmins=${isBotAdmins} | admins=${JSON.stringify(groupAdmins)}`);
                        }
                    } catch (_) {}
                }

                if (userConfig.AUTO_TYPING === 'true') await conn.sendPresenceUpdate('composing', from);
                if (userConfig.AUTO_RECORDING === 'true') await conn.sendPresenceUpdate('recording', from);
                if (userConfig.AUTO_REACT === 'true' && !isCmd) {
                    const reactEmojis = ['❤️', '🔥', '😂', '👍', '😮', '🙏', '💯', '✨'];
                    const randomReact = reactEmojis[Math.floor(Math.random() * reactEmojis.length)];
                    // Temporary: was silently swallowing errors with .catch(()=>{}), which
                    // hid the real reason reactions weren't appearing. Now logs it.
                    conn.sendMessage(from, { react: { text: randomReact, key: mek.key } })
                        .catch((e) => console.log('[AUTOREACT ERROR]', e.message));
                }

                // Anti-link: delete messages containing links from non-admins, if enabled for this group
                if (isGroup && !isAdmins && !isOwner && body) {
                    try {
                        const { getGroupSettings } = require('./data/GroupSettings');
                        const gSettings = await getGroupSettings(from);
                        const linkRegex = /(chat\.whatsapp\.com|https?:\/\/)/i;
                        if (gSettings.antilink && linkRegex.test(body) && isBotAdmins) {
                            await conn.sendMessage(from, { delete: mek.key });
                            await conn.sendMessage(from, {
                                text: `🔗 Links are not allowed here, @${sender.split('@')[0]}!`,
                                mentions: [sender]
                            });
                        }
                    } catch (_) {}
                }

                // 🚨 BUG FIX (fake-sender / ugly-forward-box bug): this used to
                // (1) build a fake "quoted" message with hardcoded garbage jids
                // (13135550002@s.whatsapp.net / 0@s.whatsapp.net), and (2) wrap
                // every reply in a fake "forwarded from a newsletter/channel"
                // contextInfo. Together these made WhatsApp render every single
                // reply as a big "Forwarded many times → AI・Status → Contact:
                // AHMAD-MD" box, and on @lid groups the fake jids could get
                // mis-resolved to a REAL group member — so replies looked like
                // they were coming from a random real member (e.g. showing a
                // group member's name) instead of the bot. Both were purely
                // cosmetic and not worth the risk/clutter, so replies are now
                // sent plain, just quoting the real incoming command message.
                const myquoted = mek;
                const reply = (text) => conn.sendMessage(from, { text }, { quoted: mek });
                const l = reply;

                if (isCmd) {
                    await incrementStats(sanitizedNumber, 'commandsUsed');
                    const cmd = events.commands.find(c => c.pattern === command) || events.commands.find(c => c.alias && c.alias.includes(command));
                    if (cmd) {
                        if (config.WORK_TYPE === 'private' && !isOwner) return;

                        // 🚨 BUG FIX: .setcommandcooldown/.cooldown only ever SET
                        // config.CMD_COOLDOWN — nothing ever read it, so spamming
                        // commands rapid-fire was never actually throttled (risking
                        // API rate-limits or a WhatsApp spam flag on the bot number).
                        // Now it's enforced per sender, skipping silently (no extra
                        // reply spam) if they're still inside the cooldown window.
                        // Owner is exempt so testing/admin work isn't slowed down.
                        const cooldownSec = Number(config.CMD_COOLDOWN) || 0;
                        if (cooldownSec > 0 && !isOwner) {
                            const key = `${botNumber}:${sender}`;
                            const now = Date.now();
                            const last = lastCommandAt.get(key) || 0;
                            if (now - last < cooldownSec * 1000) return;
                            lastCommandAt.set(key, now);
                        }

                        if (cmd.react) conn.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
                        try {
                            cmd.function(conn, mek, m, { from, quoted: quotedMsg, mentionedJid, body, isCmd, command, args, q, text, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply, config, myquoted });
                        } catch (e) { zaidiLog(`PLUGIN ERROR [${command}]: ${e.message}`, 'error'); }
                    }
                }

                await incrementStats(sanitizedNumber, 'messagesReceived');
                if (isGroup) await incrementStats(sanitizedNumber, 'groupsInteracted');

                events.commands.map(async (evCmd) => {
                    const ctx = { from, l, quoted: quotedMsg, mentionedJid, body, isCmd, command, args, q, text, isGroup, sender, senderNumber, botNumber2, botNumber, pushname, isMe, isOwner, isCreator, groupMetadata, groupName, participants, groupAdmins, isBotAdmins, isAdmins, reply, config, myquoted };
                    if (body && evCmd.on === 'body') evCmd.function(conn, mek, m, ctx);
                    else if (mek.q && evCmd.on === 'text') evCmd.function(conn, mek, m, ctx);
                    else if ((evCmd.on === 'image' || evCmd.on === 'photo') && mek.type === 'imageMessage') evCmd.function(conn, mek, m, ctx);
                    else if (evCmd.on === 'sticker' && mek.type === 'stickerMessage') evCmd.function(conn, mek, m, ctx);
                });

            } catch (e) { zaidiLog(`Message handler error: ${e.message}`, 'error'); }
        });

    } catch (err) {
        zaidiLog(`𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪 Pair error: ${err.message}`, 'error');
        if (res && !res.headersSent) return res.json({ error: 'Internal Server Error', details: err.message });
    } finally {
        if (connectionLockKey) global[connectionLockKey] = false;
    }
}


router.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pair.html')));
router.get('/code', async (req, res) => { if (!req.query.number) return res.json({ error: 'Number required' }); await zaidiPair(req.query.number, res); });
router.get('/status', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        const list = Array.from(activeSockets.keys()).map(n => { const s = getConnectionStatus(n); return { number: n, status: 'connected', connectionTime: s.connectionTime, uptime: `${s.uptime} seconds` }; });
        return res.json({ totalActive: activeSockets.size, connections: list });
    }
    const s = getConnectionStatus(number);
    res.json({ number, isConnected: s.isConnected, connectionTime: s.connectionTime, uptime: `${s.uptime} seconds` });
});
router.get('/disconnect', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    const n = number.replace(/[^0-9]/g, '');
    if (!activeSockets.has(n)) return res.status(404).json({ error: 'Not found' });
    try {
        const socket = activeSockets.get(n);
        await socket.ws.close(); socket.ev.removeAllListeners();
        activeSockets.delete(n); socketCreationTime.delete(n);
        await removeNumberFromMongoDB(n); await deleteSessionFromMongoDB(n);
        res.json({ status: 'success', message: 'Disconnected' });
    } catch (e) { res.status(500).json({ error: 'Failed to disconnect' }); }
});
router.get('/active', (req, res) => res.json({ count: activeSockets.size, numbers: Array.from(activeSockets.keys()) }));
router.get('/ping', (req, res) => res.json({ status: 'active', message: '𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪 is running 🔥', activeSessions: activeSockets.size }));
router.get('/connect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongoDB();
        if (!numbers.length) return res.status(404).json({ error: 'No numbers found' });
        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
            const mockRes = { headersSent: false, json: () => {}, status: () => mockRes };
            await zaidiPair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
            await delay(1000);
        }
        res.json({ status: 'success', total: numbers.length, connections: results });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) return res.status(400).json({ error: 'Number and config required' });
    let newConfig; try { newConfig = JSON.parse(configString); } catch (_) { return res.status(400).json({ error: 'Invalid config' }); }
    const n = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(n);
    if (!socket) return res.status(404).json({ error: 'No active session' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await saveOTPToMongoDB(n, otp, newConfig);
    try {
        await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: `*🔐 𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪 — CONFIG UPDATE*\n\nOTP: *${otp}*\nValid 5 minutes` });
        res.json({ status: 'otp_sent' });
    } catch (e) { res.status(500).json({ error: 'Failed to send OTP' }); }
});
router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) return res.status(400).json({ error: 'Number and OTP required' });
    const n = number.replace(/[^0-9]/g, '');
    const verification = await verifyOTPFromMongoDB(n, otp);
    if (!verification.valid) return res.status(400).json({ error: verification.error });
    await updateUserConfigInMongoDB(n, verification.config);
    const socket = activeSockets.get(n);
    if (socket) await socket.sendMessage(jidNormalizedUser(socket.user.id), { text: '*✅ CONFIG UPDATED*' });
    res.json({ status: 'success' });
});
router.get('/stats', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).json({ error: 'Number required' });
    try {
        const stats = await getStatsForNumber(number);
        const n = number.replace(/[^0-9]/g, '');
        const s = getConnectionStatus(n);
        res.json({ number: n, connectionStatus: s.isConnected ? 'Connected' : 'Disconnected', uptime: s.uptime, stats });
    } catch (e) { res.status(500).json({ error: 'Failed' }); }
});



async function autoReconnectFromMongoDB() {
    try {
        zaidiLog('Attempting auto-reconnect from MongoDB...', 'info');
        const numbers = await getAllNumbersFromMongoDB();
        if (!numbers.length) { zaidiLog('No numbers in MongoDB', 'info'); return; }
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, json: () => {}, status: () => mockRes };
                await zaidiPair(number, mockRes);
                await delay(2000);
            }
        }
        zaidiLog('Auto-reconnect completed', 'success');
    } catch (e) { zaidiLog(`autoReconnectFromMongoDB error: ${e.message}`, 'error'); }
}

setTimeout(() => { autoReconnectFromMongoDB(); }, 3000);



process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch (_) {}
        activeSockets.delete(number); socketCreationTime.delete(number);
    });
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) fs.emptyDirSync(sessionDir);
});

process.on('uncaughtException', (err) => {
    zaidiLog(`Uncaught exception: ${err.message}`, 'error');
});

module.exports = router;
