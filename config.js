const fs = require('fs');
const dotenv = require('dotenv');

if (fs.existsSync('.env')) {
    dotenv.config({ path: '.env' });
}

module.exports = {
    // ===========================================================
    // 1. CONFIGURATION DE BASE (Session & Database)
    // ===========================================================
    SESSION_ID: process.env.SESSION_ID || "MINI BOT", 
    // ⚠️⚠️⚠️ REPLACE THIS — ye kisi aur ka MongoDB hai, apna session isme mat save karo!
    // Apna free cluster yahan se banao: https://www.mongodb.com/cloud/atlas/register
    MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://romy6220_db_user:jCaKwpMVHVLOeqi7@cluster0.tjswwlb.mongodb.net/?appName=Cluster0',
    
    // ===========================================================
    // 2. INFORMATIONS DU BOT
    // ===========================================================
    PREFIX: process.env.PREFIX || '.',
    // 🚨 BUG FIX: this had a leading "+" ('+923044975027'). Every place that
    // builds a JID does `OWNER_NUMBER + "@s.whatsapp.net"` — with the "+" that
    // becomes an INVALID jid ("+923044975027@s.whatsapp.net"), so any send to
    // the owner (`.vv`, antidelete set to "private", etc.) silently failed.
    // Stripping non-digits here fixes it everywhere at once.
    OWNER_NUMBER: (process.env.OWNER_NUMBER || '923044975027').replace(/[^0-9]/g, ''), // Mettez votre numéro ici
    BOT_NAME: "𓆩𝑨𝑯𝑴𝑨𝑫-𝑴𝑫𓆪",
    // ⚠️ REPLACE THIS — apni RapidAPI key daalo (rapidapi.com se free account)
    RAPID_API_KEY: process.env.RAPID_API_KEY || 'b98acee8f5msh4a4fba7da6018ddp1caf30jsn44a2220ad16f',
    CHANNEL_JID: process.env.CHANNEL_JID || '120363427856127926@newsletter', // Apna channel JID yahan daalo
    BOT_FOOTER: '© ᴘᴏᴡᴇʀᴇᴅ ʙʏ 𝒂𝒉𝒎𝒂𝒅',
    
    // Mode de travail : public, private, group, inbox
    WORK_TYPE: process.env.WORK_TYPE || "public", 

    // Minimum seconds between commands from the same person (per bot number),
    // to stop rapid-fire command spam. 0 = disabled. Owner is exempt.
    CMD_COOLDOWN: Number(process.env.CMD_COOLDOWN) || 2,
    
    // ===========================================================
    // 3. FONCTIONNALITÉS AUTOMATIQUES (STATUTS)
    // ===========================================================
    AUTO_VIEW_STATUS: process.env.AUTO_VIEW_STATUS || 'true', // Voir automatiquement les statuts
    AUTO_LIKE_STATUS: process.env.AUTO_LIKE_STATUS || 'true', // Liker automatiquement les statuts
    AUTO_LIKE_EMOJI: ['❤️', '🌹', '✨', '🥰', '🌹', '😍', '💞', '💕', '☺️', '🤗'], 
    
    AUTO_STATUS_REPLY: process.env.AUTO_STATUS_REPLY || 'false', // Répondre aux statuts
    AUTO_STATUS_MSG: process.env.AUTO_STATUS_MSG || '🤗', // Message de réponse
    
    // ===========================================================
    // 4. FONCTIONNALITÉS DE CHAT & PRÉSENCE
    // ===========================================================
    READ_MESSAGE: process.env.READ_MESSAGE || 'false', // Marquer les messages comme lus (Blue Tick)
    AUTO_TYPING: process.env.AUTO_TYPING || 'false', // Afficher "Écrit..."
    AUTO_RECORDING: process.env.AUTO_RECORDING || 'false', // Afficher "Enregistre..."
    AUTO_REACT: process.env.AUTO_REACT || 'false', // Auto react on every message
    
    // ===========================================================
    // 5. GESTION DES GROUPES
    // ===========================================================
    WELCOME_ENABLE: process.env.WELCOME_ENABLE || 'true',
    GOODBYE_ENABLE: process.env.GOODBYE_ENABLE || 'true',
    WELCOME_MSG: process.env.WELCOME_MSG || null, 
    GOODBYE_MSG: process.env.GOODBYE_MSG || null, 
    WELCOME_IMAGE: process.env.WELCOME_IMAGE || null, 
    GOODBYE_IMAGE: process.env.GOODBYE_IMAGE || null,
    
    GROUP_INVITE_LINK: process.env.GROUP_INVITE_LINK || 'https://chat.whatsapp.com/HE7P1KjA1gxBR3pcuQ110S',
    
    // ===========================================================
    // 6. SÉCURITÉ & ANTI-CALL
    // ===========================================================
    ANTI_CALL: process.env.ANTI_CALL || 'false', // Rejeter les appels
    REJECT_MSG: process.env.REJECT_MSG || '*CALL LATER PLEASE ☺️🌹*',
    
    // ===========================================================
    // 7. IMAGES & LIENS
    // ===========================================================
    IMAGE_PATH: 'https://i.ibb.co/yBVVkT2G/1000199611.png',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbCNhy7BKfhvVOR9nz3X',
    
    // ===========================================================
    // 8. EXTERNAL API (Optionnel)
    // ===========================================================
    // ⚠️ REPLACE THIS — apna Telegram bot token daalo (@BotFather se)
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8986362228:AAEbboa3sD0wrfZY1m19Ybmr6paMSSSkwsU',
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '+923044975027'
    
};
  
