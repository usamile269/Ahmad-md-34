// Prevent the whole server from crashing on an unexpected error anywhere in the app.
// Without these, any single unhandled rejection (a stray API call, a bad media message, etc.)
// kills the entire Node process on modern Node versions — which matches the "bot crashes,
// needs manual restart" symptom. Now it just gets logged and the bot keeps running.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Rejection (bot kept running):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception (bot kept running):', err);
});

const express = require('express');
const app = express();
const port = process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 8000;
const bodyParser = require('body-parser');
const cors = require('cors');

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const pairRouter = require('./main');
app.use('/', pairRouter);

app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
});

// Start Telegram pairing bot
try {
    require('./telegram-pair');
} catch (e) {
    console.error('Telegram pairing bot failed to start:', e.message);
}

module.exports = app;
