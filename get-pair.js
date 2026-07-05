// Console-based pairing — no browser needed
// Usage: node get-pair.js 923XXXXXXXXX

const router = require('./main');

const number = process.argv[2];

if (!number) {
    console.log('❌ Usage: node get-pair.js YOUR_NUMBER');
    console.log('   Example: node get-pair.js 923001234567');
    process.exit(1);
}

console.log(`🔐 Requesting pairing code for: ${number}`);
console.log('⏳ Please wait...\n');

// Give MongoDB connection time to establish
setTimeout(async () => {
    try {
        const http = require('http');
        const app = require('express')();
        app.use('/', router);
        const server = app.listen(0, async () => {
            const port = server.address().port;
            http.get(`http://localhost:${port}/code?number=${number}`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.code) {
                            console.log('✅ YOUR PAIRING CODE:');
                            console.log('═══════════════════');
                            console.log(`   ${parsed.code}`);
                            console.log('═══════════════════');
                            console.log('\n📱 Enter this in WhatsApp > Linked Devices > Link with phone number');
                        } else {
                            console.log('Response:', parsed);
                        }
                    } catch (e) {
                        console.log('Raw response:', data);
                    }
                    setTimeout(() => process.exit(0), 3000);
                });
            }).on('error', (e) => {
                console.error('❌ Error:', e.message);
                process.exit(1);
            });
        });
    } catch (e) {
        console.error('❌ Error:', e.message);
        process.exit(1);
    }
}, 3000);
