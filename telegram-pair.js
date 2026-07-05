// Telegram-based WhatsApp Pairing Bot
// Send your number to this Telegram bot, get pairing code back

const axios = require('axios');
const config = require('./config');
const router = require('./main');
const express = require('express');

const TELEGRAM_TOKEN = config.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

let lastUpdateId = 0;

async function getPairingCodeInternal(number) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use('/', router);
        const server = app.listen(0, () => {
            const port = server.address().port;
            axios.get(`http://localhost:${port}/code?number=${number}`)
                .then(res => {
                    server.close();
                    resolve(res.data);
                })
                .catch(err => {
                    server.close();
                    reject(err);
                });
        });
    });
}

async function sendTelegramMessage(chatId, text) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error('Telegram send error:', e.message);
    }
}

async function pollTelegram() {
    try {
        const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
            params: { offset: lastUpdateId + 1, timeout: 30 }
        });

        const updates = res.data.result;
        for (const update of updates) {
            lastUpdateId = update.update_id;

            const message = update.message;
            if (!message || !message.text) continue;

            const chatId = message.chat.id;
            const text = message.text.trim();

            if (text === '/start') {
                await sendTelegramMessage(chatId,
                    '👋 *WhatsApp Pairing Bot*\n\n' +
                    'Send me your WhatsApp number with country code (no + or spaces).\n\n' +
                    'Example: `923001234567`'
                );
                continue;
            }

            if (/^\d{10,15}$/.test(text)) {
                await sendTelegramMessage(chatId, `⏳ Requesting pairing code for *${text}*...`);
                try {
                    const result = await getPairingCodeInternal(text);
                    if (result.code) {
                        await sendTelegramMessage(chatId,
                            `✅ *Your Pairing Code:*\n\n` +
                            `\`${result.code}\`\n\n` +
                            `📱 Open WhatsApp > Linked Devices > Link with phone number, and enter this code.`
                        );
                    } else {
                        await sendTelegramMessage(chatId, `⚠️ ${JSON.stringify(result)}`);
                    }
                } catch (e) {
                    await sendTelegramMessage(chatId, `❌ Error: ${e.message}`);
                }
            } else {
                await sendTelegramMessage(chatId, '❌ Please send a valid number with country code (e.g. 923001234567)');
            }
        }
    } catch (e) {
        console.error('Telegram poll error:', e.message);
    }

    setTimeout(pollTelegram, 2000);
}

console.log('🤖 Telegram pairing bot starting...');
console.log('   Open Telegram, find your bot, and send /start');
pollTelegram();
