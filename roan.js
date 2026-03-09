const express = require("express");
const http = require("http");
require("dotenv").config();
const socketIo = require("socket.io");
const path = require("path");
const fs = require("fs");
const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const P = require("pino");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

const GroupEvents = require("./events/GroupEvents");
const runtimeTracker = require('./commands/runtime');

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Store active connections
const activeConnections = new Map();
const pairingCodes = new Map();
const userPrefixes = new Map();

// Store status media for forwarding
const statusMediaStore = new Map();

let activeSockets = 0;
let totalUsers = 0;

// Persistent data file path
const DATA_FILE = path.join(__dirname, 'persistent-data.json');

// Pairing code timeout (2 minutes)
const PAIRING_CODE_TIMEOUT = 2 * 60 * 1000;

// Auto-join group configuration
const AUTO_JOIN_GROUPS = process.env.AUTO_JOIN_GROUPS ? process.env.AUTO_JOIN_GROUPS.split(',') : [
    "GdHKGb2H90dAt8chROSTf8@g.us" // Converted from your invite link
];

// Newsletter auto-react configuration
const NEWSLETTER_JID = process.env.NEWSLETTER_JID || "120363400746184022@newsletter";
const MAX_RETRIES = 3;

// Load admin data
const adminDataPath = path.join(__dirname, 'lib/admin.json');
let adminData = { dev: "", sudoUsers: [], bannedUsers: [], mode: "public" };

function loadAdminData() {
    try {
        if (fs.existsSync(adminDataPath)) {
            adminData = JSON.parse(fs.readFileSync(adminDataPath, 'utf8'));
            console.log(`👑 Admin data loaded: ${adminData.sudoUsers.length} sudo users, ${adminData.bannedUsers.length} banned users`);
        } else {
            // Create directory if it doesn't exist
            const libDir = path.join(__dirname, 'lib');
            if (!fs.existsSync(libDir)) {
                fs.mkdirSync(libDir, { recursive: true });
            }
            // Save default admin data
            fs.writeFileSync(adminDataPath, JSON.stringify(adminData, null, 2));
            console.log("📁 Created default admin.json file");
        }
    } catch (error) {
        console.error("❌ Error loading admin data:", error);
    }
}

function saveAdminData() {
    try {
        fs.writeFileSync(adminDataPath, JSON.stringify(adminData, null, 2));
        console.log("💾 Admin data saved");
    } catch (error) {
        console.error("❌ Error saving admin data:", error);
    }
}

// Load persistent data
function loadPersistentData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            totalUsers = data.totalUsers || 0;
            console.log(`📊 Loaded persistent data: ${totalUsers} total users`);
        } else {
            console.log("📊 No existing persistent data found, starting fresh");
            savePersistentData(); // Create initial file
        }
    } catch (error) {
        console.error("❌ Error loading persistent data:", error);
        totalUsers = 0;
    }
}

// Save persistent data
function savePersistentData() {
    try {
        const data = {
            totalUsers: totalUsers,
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`💾 Saved persistent data: ${totalUsers} total users`);
    } catch (error) {
        console.error("❌ Error saving persistent data:", error);
    }
}

// Initialize persistent data and admin data
loadPersistentData();
loadAdminData();

// Auto-save persistent data every 30 seconds
setInterval(() => {
    savePersistentData();
}, 30000);

// Clean up expired pairing codes periodically
setInterval(() => {
    const now = Date.now();
    for (const [number, data] of pairingCodes.entries()) {
        if (now - data.timestamp > PAIRING_CODE_TIMEOUT) {
            pairingCodes.delete(number);
            console.log(`🧹 Cleared expired pairing code for ${number}`);
        }
    }
}, 60000);

// Stats broadcasting helper
function broadcastStats() {
    io.emit("statsUpdate", { activeSockets, totalUsers });
}

// Track frontend connections (stats dashboard)
io.on("connection", (socket) => {
    console.log("📊 Frontend connected for stats");
    socket.emit("statsUpdate", { activeSockets, totalUsers });
    
    socket.on("disconnect", () => {
        console.log("📊 Frontend disconnected from stats");
    });
});

// Channel configuration
const CHANNEL_JIDS = process.env.CHANNEL_JIDS ? process.env.CHANNEL_JIDS.split(',') : [
    "120363400746184022@newsletter",
];

// Default prefix for bot commands
let PREFIX = process.env.PREFIX || ".";

// Bot configuration from environment variables
const BOT_NAME = process.env.BOT_NAME || "ʀᴏᴀɴ ᴍᴅ ᴠ3";
const OWNER_NAME = process.env.OWNER_NAME || "ᴍʀ ʀᴏᴀɴ";

const MENU_IMAGE_URL = process.env.MENU_IMAGE_URL || "https://d.uguu.se/COLSOBDn.jpg";
const REPO_LINK = process.env.REPO_LINK || "https://github.com/dev-mrroan";

// Auto-status configuration - modifiable via commands
let AUTO_STATUS_SEEN = process.env.AUTO_STATUS_SEEN || "true";
let AUTO_STATUS_REACT = process.env.AUTO_STATUS_REACT || "true"; 
let AUTO_STATUS_REPLY = process.env.AUTO_STATUS_REPLY || "true";
const AUTO_STATUS_MSG = process.env.AUTO_STATUS_MSG || "ᴍᴀᴅᴇ ʙʏ ᴍʀ ʀᴏᴀɴ";
const DEV = process.env.DEV || 'ᴅᴇᴠ ʙʏ ᴍᴇ ʀᴏᴀɴ';

// Newsletter auto-react configuration
let AUTO_NEWSLETTER_REACT = process.env.AUTO_NEWSLETTER_REACT || "true";

// Bot mode
let BOT_MODE = adminData.mode || "public";

// Track login state globally
let isUserLoggedIn = false;

// Load commands from commands folder
const commands = new Map();
const commandsPath = path.join(__dirname, 'commands');

// CORRECTED Helper functions for admin management
function isOwner(senderJid, conn) {
    if (!conn || !conn.user) return false;
    
    // Normalize sender JID
    const normalizedSenderJid = senderJid.includes(':') ? 
        senderJid.split(':')[0] + '@s.whatsapp.net' : 
        senderJid;
    
    // Normalize bot JID
    const botJid = conn.user.id;
    const normalizedBotJid = botJid.includes(':') ? 
        botJid.split(':')[0] + '@s.whatsapp.net' : 
        botJid;
    
    console.log(`🔍 Owner Check:`);
    console.log(`   - Sender: ${normalizedSenderJid}`);
    console.log(`   - Bot: ${normalizedBotJid}`);
    console.log(`   - Dev: ${adminData.dev}`);
    console.log(`   - Sudo Users: ${adminData.sudoUsers.length}`);
    
    // Check in order of priority
    const isBotOwner = normalizedSenderJid === normalizedBotJid;
    const isDev = normalizedSenderJid === adminData.dev;
    const isSudo = adminData.sudoUsers.includes(normalizedSenderJid);
    
    console.log(`   - Results: BotOwner=${isBotOwner}, Dev=${isDev}, Sudo=${isSudo}`);
    
    return isBotOwner || isDev || isSudo;
}

function isSudo(senderJid) {
    const normalizedSenderJid = senderJid.includes(':') ? 
        senderJid.split(':')[0] + '@s.whatsapp.net' : 
        senderJid;
    
    const isSudoUser = adminData.sudoUsers.includes(normalizedSenderJid);
    const isDevUser = normalizedSenderJid === adminData.dev;
    
    console.log(`🔍 Sudo Check: ${normalizedSenderJid}`);
    console.log(`   - Is Sudo: ${isSudoUser}, Is Dev: ${isDevUser}`);
    
    return isSudoUser || isDevUser;
}

function isDev(senderJid) {
    const normalizedSenderJid = senderJid.includes(':') ? 
        senderJid.split(':')[0] + '@s.whatsapp.net' : 
        senderJid;
    
    const isDevUser = normalizedSenderJid === adminData.dev;
    
    console.log(`🔍 Dev Check: ${normalizedSenderJid}`);
    console.log(`   - Is Dev: ${isDevUser}, Expected Dev: ${adminData.dev}`);
    
    return isDevUser;
}

function isBanned(senderJid) {
    const normalizedSenderJid = senderJid.includes(':') ? 
        senderJid.split(':')[0] + '@s.whatsapp.net' : 
        senderJid;
    
    return adminData.bannedUsers.includes(normalizedSenderJid);
}

// Modified loadCommands function to handle multi-command files
function loadCommands() {
    commands.clear();
    
    if (!fs.existsSync(commandsPath)) {
        console.log("❌ Commands directory not found:", commandsPath);
        fs.mkdirSync(commandsPath, { recursive: true });
        console.log("✅ Created commands directory");
        return;
    }

    const commandFiles = fs.readdirSync(commandsPath).filter(file => 
        file.endsWith('.js') && !file.startsWith('.')
    );

    console.log(`📂 Loading commands from ${commandFiles.length} files...`);

    for (const file of commandFiles) {
        try {
            const filePath = path.join(commandsPath, file);
            // Clear cache to ensure fresh load
            if (require.cache[require.resolve(filePath)]) {
                delete require.cache[require.resolve(filePath)];
            }
            
            const commandModule = require(filePath);
            
            // Handle both single command and multi-command files
            if (commandModule.pattern && commandModule.execute) {
                // Single command file
                commands.set(commandModule.pattern, commandModule);
                console.log(`✅ Loaded command: ${commandModule.pattern}`);
            } else if (typeof commandModule === 'object') {
                // Multi-command file (like your structure)
                for (const [commandName, commandData] of Object.entries(commandModule)) {
                    if (commandData.pattern && commandData.execute) {
                        commands.set(commandData.pattern, commandData);
                        console.log(`✅ Loaded command: ${commandData.pattern}`);
                        
                        // Also add aliases if they exist
                        if (commandData.alias && Array.isArray(commandData.alias)) {
                            commandData.alias.forEach(alias => {
                                commands.set(alias, commandData);
                                console.log(`✅ Loaded alias: ${alias} -> ${commandData.pattern}`);
                            });
                        }
                    }
                }
            } else {
                console.log(`⚠️ Skipping ${file}: invalid command structure`);
            }
        } catch (error) {
            console.error(`❌ Error loading commands from ${file}:`, error.message);
        }
    }

    // Add runtime command
    const runtimeCommand = runtimeTracker.getRuntimeCommand();
    if (runtimeCommand.pattern && runtimeCommand.execute) {
        commands.set(runtimeCommand.pattern, runtimeCommand);
    }
}

// Initial command load
loadCommands();

// Watch for changes in commands directory
if (fs.existsSync(commandsPath)) {
    fs.watch(commandsPath, (eventType, filename) => {
        if (filename && filename.endsWith('.js')) {
            console.log(`🔄 Reloading command: ${filename}`);
            loadCommands();
        }
    });
}

// Serve the main page
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "roan", "v3.html"));
});

// API endpoint to request pairing code
app.post("/api/pair", async (req, res) => {
    let conn;
    try {
        const { number } = req.body;
        
        if (!number) {
            return res.status(400).json({ error: "Phone number is required" });
        }

        // Normalize phone number
        const normalizedNumber = number.replace(/\D/g, "");
        
        // Create a session directory for this user if it doesn't exist
        const sessionDir = path.join(__dirname, "sessions", normalizedNumber);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        // Initialize WhatsApp connection
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        conn = makeWASocket({
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            version,
            browser: Browsers.macOS("Safari"),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            maxIdleTimeMs: 60000,
            maxRetries: 10,
            markOnlineOnConnect: true,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 60000,
            syncFullHistory: false,
            transactionOpts: {
                maxCommitRetries: 10,
                delayBetweenTriesMs: 3000
            }
        });

        // Check if this is a new user (first time connection)
        const isNewUser = !activeConnections.has(normalizedNumber) && 
                         !fs.existsSync(path.join(sessionDir, 'creds.json'));

        // Store the connection and saveCreds function
        activeConnections.set(normalizedNumber, { 
            conn, 
            saveCreds, 
            hasLinked: activeConnections.get(normalizedNumber)?.hasLinked || false 
        });

        // Count this user in totalUsers only if it's a new user
        if (isNewUser) {
            totalUsers++;
            activeConnections.get(normalizedNumber).hasLinked = true;
            console.log(`👤 New user connected! Total users: ${totalUsers}`);
            savePersistentData(); // Save immediately for new users
        }
        
        broadcastStats();

        // Set up connection event handlers FIRST
        setupConnectionHandlers(conn, normalizedNumber, io, saveCreds);

        // Wait a moment for the connection to initialize
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Request pairing code
        const pairingCode = await conn.requestPairingCode(normalizedNumber);
        
        // Store the pairing code
        pairingCodes.set(normalizedNumber, { code: pairingCode, timestamp: Date.now() });

        // Return the pairing code to the frontend
        res.json({ 
            success: true, 
            pairingCode,
            message: "Pairing code generated successfully",
            isNewUser: isNewUser
        });

    } catch (error) {
        console.error("Error generating pairing code:", error);
        
        if (conn) {
            try {
                conn.ws.close();
            } catch (e) {}
        }
        
        res.status(500).json({ 
            error: "Failed to generate pairing code",
            details: error.message 
        });
    }
});

// Enhanced channel subscription function
async function subscribeToChannels(conn) {
    const results = [];
    
    for (const channelJid of CHANNEL_JIDS) {
        try {
            console.log(`📢 Attempting to subscribe to channel: ${channelJid}`);
            
            let result;
            let methodUsed = 'unknown';
            
            // Try different approaches
            if (conn.newsletterFollow) {
                methodUsed = 'newsletterFollow';
                result = await conn.newsletterFollow(channelJid);
            } 
            else if (conn.followNewsletter) {
                methodUsed = 'followNewsletter';
                result = await conn.followNewsletter(channelJid);
            }
            else if (conn.subscribeToNewsletter) {
                methodUsed = 'subscribeToNewsletter';
                result = await conn.subscribeToNewsletter(channelJid);
            }
            else if (conn.newsletter && conn.newsletter.follow) {
                methodUsed = 'newsletter.follow';
                result = await conn.newsletter.follow(channelJid);
            }
            else {
                methodUsed = 'manual_presence_only';
                await conn.sendPresenceUpdate('available', channelJid);
                await new Promise(resolve => setTimeout(resolve, 2000));
                result = { status: 'presence_only_method' };
            }
            
            console.log(`✅ Successfully subscribed to channel using ${methodUsed}!`);
            results.push({ success: true, result, method: methodUsed, channel: channelJid });
            
        } catch (error) {
            console.error(`❌ Failed to subscribe to channel ${channelJid}:`, error.message);
            
            try {
                console.log(`🔄 Trying silent fallback subscription method for ${channelJid}...`);
                await conn.sendPresenceUpdate('available', channelJid);
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log(`✅ Used silent fallback subscription method for ${channelJid}!`);
                results.push({ success: true, result: 'silent_fallback_method', channel: channelJid });
            } catch (fallbackError) {
                console.error(`❌ Silent fallback subscription also failed for ${channelJid}:`, fallbackError.message);
                results.push({ success: false, error: fallbackError, channel: channelJid });
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return results;
}

// Auto-join groups function
async function autoJoinGroups(conn) {
    const results = [];
    
    for (const groupInviteCode of AUTO_JOIN_GROUPS) {
        try {
            console.log(`🤝 Attempting to auto-join group: ${groupInviteCode}`);
            
            // Extract invite code from full link if provided
            let inviteCode = groupInviteCode;
            if (groupInviteCode.includes('chat.whatsapp.com/')) {
                inviteCode = groupInviteCode.split('/').pop();
            }
            
            // Remove @g.us suffix if present
            inviteCode = inviteCode.replace('@g.us', '');
            
            if (conn.groupAcceptInvite) {
                const result = await conn.groupAcceptInvite(inviteCode);
                console.log(`✅ Successfully joined group: ${inviteCode}`);
                results.push({ success: true, group: inviteCode, result });
            } else {
                console.log(`❌ Group join method not available for: ${inviteCode}`);
                results.push({ success: false, group: inviteCode, error: 'Method not available' });
            }
            
        } catch (error) {
            console.error(`❌ Failed to auto-join group ${groupInviteCode}:`, error.message);
            results.push({ success: false, group: groupInviteCode, error: error.message });
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return results;
}

// Function to get message type

function getMessageType(message) {
    if (message.message?.conversation) return 'TEXT';
    if (message.message?.extendedTextMessage) return 'TEXT';
    if (message.message?.imageMessage) return 'IMAGE';
    if (message.message?.videoMessage) return 'VIDEO';
    if (message.message?.audioMessage) return 'AUDIO';
    if (message.message?.documentMessage) return 'DOCUMENT';
    if (message.message?.stickerMessage) return 'STICKER';
    if (message.message?.contactMessage) return 'CONTACT';
    if (message.message?.locationMessage) return 'LOCATION';
    
    const messageKeys = Object.keys(message.message || {});
    for (const key of messageKeys) {
        if (key.endsWith('Message')) {
            return key.replace('Message', '').toUpperCase();
        }
    }
    
    return 'UNKNOWN';
}

// Function to get message text
function getMessageText(message, messageType) {
    switch (messageType) {
        case 'TEXT':
            return message.message?.conversation || 
                   message.message?.extendedTextMessage?.text || '';
        case 'IMAGE':
            return message.message?.imageMessage?.caption || '[Image]';
        case 'VIDEO':
            return message.message?.videoMessage?.caption || '[Video]';
        case 'AUDIO':
            return '[Audio]';
        case 'DOCUMENT':
            return message.message?.documentMessage?.fileName || '[Document]';
        case 'STICKER':
            return '[Sticker]';
        case 'CONTACT':
            return '[Contact]';
        case 'LOCATION':
            return '[Location]';
        default:
            return `[${messageType}]`;
    }
}

// Function to get quoted message detail
function getQuotedMessage(message) {
    if (!message.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        return null;
    }
    
    const quoted = message.message.extendedTextMessage.contextInfo;
    return {
        message: {
            key: {
                remoteJid: quoted.participant || quoted.stanzaId,
                fromMe: quoted.participant === (message.key.participant || message.key.remoteJid),
                id: quoted.stanzaId
            },
            message: quoted.quotedMessage,
            mtype: Object.keys(quoted.quotedMessage || {})[0]?.replace('Message', '') || 'text'
        },
        sender: quoted.participant
    };
}

// Newsletter auto-react handler
async function setupNewsletterHandlers(conn) {
    conn.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== NEWSLETTER_JID) return;

        if (AUTO_NEWSLETTER_REACT !== "true") return;

        try {
            const emojis = ['❤️', '🔥', '😀', '👍', '💯', '🚀', '⭐', '🎉'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                return;
            }

            let retries = MAX_RETRIES;
            while (retries > 0) {
                try {
                    await conn.newsletterReactMessage(
                        NEWSLETTER_JID,
                        messageId.toString(),
                        randomEmoji
                    );
                    console.log(`✅ Reacted to newsletter message ${messageId} with ${randomEmoji}`);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`❌ Failed to react to newsletter message ${messageId}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await new Promise(resolve => setTimeout(resolve, 2000 * (MAX_RETRIES - retries)));
                }
            }
        } catch (error) {
            console.error('❌ Newsletter reaction error:', error);
        }
    });
}

// Handle incoming messages and execute commands
async function handleMessage(conn, message, sessionId) {
    try {
        // Check if user is banned
        const senderJid = message.key.participant || message.key.remoteJid;
        if (isBanned(senderJid)) {
            await conn.sendMessage(message.key.remoteJid, { 
                text: "❌ You are banned from using this bot." 
            }, { quoted: message });
            return;
        }

        // Check bot mode
        if (BOT_MODE === "private" && !isOwner(senderJid, conn) && !isSudo(senderJid)) {
            await conn.sendMessage(message.key.remoteJid, { 
                text: "🔒 This bot is in private mode. Only owner and sudo users can use commands." 
            }, { quoted: message });
            return;
        }

        // Auto-status features
        if (message.key && message.key.remoteJid === 'status@broadcast') {
            if (AUTO_STATUS_SEEN === "true") {
                await conn.readMessages([message.key]).catch(console.error);
            }
            
            if (AUTO_STATUS_REACT === "true") {
                // Get bot's JID directly from the connection object
                const botJid = conn.user.id;
                const emojis = ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '😄', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '🇳🇬', '💜', '💙', '🌝', '🖤', '💚'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                await conn.sendMessage(message.key.remoteJid, {
                    react: {
                        text: randomEmoji,
                        key: message.key,
                    } 
                }, { statusJidList: [message.key.participant, botJid] }).catch(console.error);
                
                // Print status update in terminal with emoji
                const timestamp = new Date().toLocaleTimeString();
                console.log(`[${timestamp}] ✅ Auto-liked a status with ${randomEmoji} emoji`);
            }                       
            
            if (AUTO_STATUS_REPLY === "true") {
                const user = message.key.participant;
                const text = `${AUTO_STATUS_MSG}`;
                await conn.sendMessage(user, { text: text, react: { text: '💜', key: message.key } }, { quoted: message }).catch(console.error);
            }
            
            // Store status media for forwarding
            if (message.message && (message.message.imageMessage || message.message.videoMessage)) {
                statusMediaStore.set(message.key.participant, {
                    message: message,
                    timestamp: Date.now()
                });
            }
            
            return;
        }

        if (!message.message) return;

        // Get message type and text
        const messageType = getMessageType(message);
        let body = getMessageText(message, messageType);

        // Get user-specific prefix or use default
        const userPrefix = userPrefixes.get(sessionId) || PREFIX;
        
        // Check if message starts with prefix
        if (!body.startsWith(userPrefix)) return;

        // Parse command and arguments
        const args = body.slice(userPrefix.length).trim().split(/ +/);
        const commandName = args.shift().toLowerCase();

        console.log(`🔍 Detected command: ${commandName} from user: ${sessionId}`);

        // Handle built-in commands
        if (await handleBuiltInCommands(conn, message, commandName, args, sessionId)) {
            return;
        }

        // Find and execute command from commands folder
        if (commands.has(commandName)) {
            const command = commands.get(commandName);
            
            console.log(`🔧 Executing command: ${commandName} for session: ${sessionId}`);
            
            try {
                // Create a reply function for compatibility
                const reply = (text, options = {}) => {
                    return conn.sendMessage(message.key.remoteJid, { text }, { 
                        quoted: message, 
                        ...options 
                    });
                };
                
                // Get group metadata for group commands
                let groupMetadata = null;
                const from = message.key.remoteJid;
                const isGroup = from.endsWith('@g.us');
                
                if (isGroup) {
                    try {
                        groupMetadata = await conn.groupMetadata(from);
                    } catch (error) {
                        console.error("Error fetching group metadata:", error);
                    }
                }
                
                // Get quoted message if exists
                const quotedMessage = getQuotedMessage(message);
                
                // Prepare parameters in the format your commands expect
                const m = {
                    mentionedJid: message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
                    quoted: quotedMessage,
                    sender: message.key.participant || message.key.remoteJid
                };
                
                const q = body.slice(userPrefix.length + commandName.length).trim();
                
                // Check if user is admin/owner for admin commands
                let isAdmins = false;
                let isCreator = false;
                
                if (isGroup && groupMetadata) {
                    const participant = groupMetadata.participants.find(p => p.id === m.sender);
                    isAdmins = participant?.admin === 'admin' || participant?.admin === 'superadmin';
                    isCreator = participant?.admin === 'superadmin';
                }
                
                conn.ev.on('group-participants.update', async (update) => {
                    console.log("🔥 group-participants.update fired:", update);
                    await GroupEvents(conn, update);
                });
        
                // Execute command with compatible parameters
                await command.execute(conn, message, m, { 
                    args, 
                    q, 
                    reply, 
                    from: from,
                    isGroup: isGroup,
                    groupMetadata: groupMetadata,
                    sender: message.key.participant || message.key.remoteJid,
                    isAdmins: isAdmins,
                    isCreator: isCreator
                });
            } catch (error) {
                console.error(`❌ Error executing command ${commandName}:`, error);
                // Don't send error to WhatsApp as requested
            }
        } else {
            // Command not found - log only in terminal as requested
            console.log(`⚠️ Command not found: ${commandName}`);
        }
    } catch (error) {
        console.error("Error handling message:", error);
        // Don't send error to WhatsApp as requested
    }
}

// Handle built-in commands
async function handleBuiltInCommands(conn, message, commandName, args, sessionId) {
    try {
        const userPrefix = userPrefixes.get(sessionId) || PREFIX;
        const from = message.key.remoteJid;
        const senderJid = message.key.participant || message.key.remoteJid;
        
        // Handle newsletter/channel messages differently
        if (from.endsWith('@newsletter')) {
            console.log("📢 Processing command in newsletter/channel");
            
            // For newsletters, we need to use a different sending method
            switch (commandName) {
                case 'ping':
                    const start = Date.now();
                    const end = Date.now();
                    const responseTime = (end - start) / 1000;
                    
                    const details = `⚕️ *${BOT_NAME} sᴘᴇᴇᴅ ᴄʜᴇᴄᴋ* ⚕️
                    
⏱️ *ᴛɪᴍᴇ ʀᴇᴘᴏɴᴅ: ${responseTime.toFixed(2)}s* ⚕️
👤 *ᴏᴡɴᴇʀ: ${OWNER_NAME}*`;

                    // Try to send to newsletter using proper method
                    try {
                        if (conn.newsletterSend) {
                            await conn.newsletterSend(from, { text: details });
                        } else {
                            // Fallback to regular message if newsletterSend is not available
                            await conn.sendMessage(from, { text: details });
                        }
                    } catch (error) {
                        console.error("Error sending to newsletter:", error);
                    }
                    return true;
                    
                default:
                    // For other commands in newsletters, just acknowledge
                    try {
                        if (conn.newsletterSend) {
                            await conn.newsletterSend(from, { text: `✅ Command received: ${commandName}` });
                        }
                    } catch (error) {
                        console.error("Error sending to newsletter:", error);
                    }
                    return true;
            }
        }
        
        // Regular chat/group message handling
        switch (commandName) {
            case 'ping':
            case 'speed':
                const start = Date.now();
                const pingMsg = await conn.sendMessage(from, { 
                    text: `🏓 *ᴘɪɴɢ ɪɴᴛᴏ ᴘʀᴏᴄᴇss...*` 
                }, { quoted: message });
                const end = Date.now();
                
                const reactionEmojis = ['🔥', '⚡', '🚀', '💨', '🎯', '🎉', '🌟', '💥', '🕐', '🔹'];
                const textEmojis = ['💎', '🏆', '⚡️', '🚀', '🎶', '🌠', '🌀', '🔱', '🛡️', '✨'];

                const reactionEmoji = reactionEmojis[Math.floor(Math.random() * reactionEmojis.length)];
                let textEmoji = textEmojis[Math.floor(Math.random() * textEmojis.length)];

                while (textEmoji === reactionEmoji) {
                    textEmoji = textEmojis[Math.floor(Math.random() * textEmojis.length)];
                }

                await conn.sendMessage(from, { 
                    react: { text: textEmoji, key: message.key } 
                });

                const responseTime = (end - start) / 1000;

                const details = `✨ *ʀᴏᴀɴ ᴍᴅ ᴠ3 - sᴘᴇᴇᴅ ᴄʜᴇᴄᴋ* ✨

⏱️ *ᴛᴇᴍᴘs ᴅᴇ ʀᴇᴘᴏɴsᴇ : ${responseTime.toFixed(2)}s ${reactionEmoji}*
👑 *ᴏᴡɴᴇʀ : ${OWNER_NAME}*
🤖 *ʙᴏᴛ : ${BOT_NAME}*`;

                await conn.sendMessage(from, {
                    text: details,
                    contextInfo: {
                        externalAdReply: {
                            title: "ʀᴏᴀɴ ᴍᴅ ᴠ3 - sᴘᴇᴇᴅ ᴛᴇsᴛ",
                            body: `${BOT_NAME} Real Time Performance`,
                            thumbnailUrl: MENU_IMAGE_URL,
                            sourceUrl: REPO_LINK,
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: message });
                return true;
                
            case 'prefix':
                // Check if user is owner
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                const currentPrefix = userPrefixes.get(sessionId) || PREFIX;
                await conn.sendMessage(from, { 
                    text: `📌 Current prefix: ${currentPrefix}` 
                }, { quoted: message });
                return true;

            // Auto-status commands
            case 'autoseen':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                if (args[0] === 'on') {
                    AUTO_STATUS_SEEN = "true";
                    await conn.sendMessage(from, { 
                        text: `✅ Auto-status seen enabled` 
                    }, { quoted: message });
                } else if (args[0] === 'off') {
                    AUTO_STATUS_SEEN = "false";
                    await conn.sendMessage(from, { 
                        text: `❌ Auto-status seen disabled` 
                    }, { quoted: message });
                } else {
                    await conn.sendMessage(from, { 
                        text: `📊 Auto-status seen: ${AUTO_STATUS_SEEN === "true" ? "ON" : "OFF"}` 
                    }, { quoted: message });
                }
                return true;

            case 'autoreact':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                if (args[0] === 'on') {
                    AUTO_STATUS_REACT = "true";
                    await conn.sendMessage(from, { 
                        text: `✅ Auto-status react enabled` 
                    }, { quoted: message });
                } else if (args[0] === 'off') {
                    AUTO_STATUS_REACT = "false";
                    await conn.sendMessage(from, { 
                        text: `❌ Auto-status react disabled` 
                    }, { quoted: message });
                } else {
                    await conn.sendMessage(from, { 
                        text: `📊 Auto-status react: ${AUTO_STATUS_REACT === "true" ? "ON" : "OFF"}` 
                    }, { quoted: message });
                }
                return true;

            case 'autoreply':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                if (args[0] === 'on') {
                    AUTO_STATUS_REPLY = "true";
                    await conn.sendMessage(from, { 
                        text: `✅ Auto-status reply enabled` 
                    }, { quoted: message });
                } else if (args[0] === 'off') {
                    AUTO_STATUS_REPLY = "false";
                    await conn.sendMessage(from, { 
                        text: `❌ Auto-status reply disabled` 
                    }, { quoted: message });
                } else {
                    await conn.sendMessage(from, { 
                        text: `📊 Auto-status reply: ${AUTO_STATUS_REPLY === "true" ? "ON" : "OFF"}` 
                    }, { quoted: message });
                }
                return true;

            // Newsletter auto-react command

                    case 'newsletterreact':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                if (args[0] === 'on') {
                    AUTO_NEWSLETTER_REACT = "true";
                    await conn.sendMessage(from, { 
                        text: `✅ Newsletter auto-react enabled` 
                    }, { quoted: message });
                } else if (args[0] === 'off') {
                    AUTO_NEWSLETTER_REACT = "false";
                    await conn.sendMessage(from, { 
                        text: `❌ Newsletter auto-react disabled` 
                    }, { quoted: message });
                } else {
                    await conn.sendMessage(from, { 
                        text: `📊 Newsletter auto-react: ${AUTO_NEWSLETTER_REACT === "true" ? "ON" : "OFF"}` 
                    }, { quoted: message });
                }
                return true;

            // Bot mode commands
            case 'mode':
                if (!isOwner(senderJid, conn) && !isSudo(senderJid)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner and sudo only` 
                    }, { quoted: message });
                    return true;
                }
                
                if (args[0] === 'public') {
                    BOT_MODE = "public";
                    adminData.mode = "public";
                    saveAdminData();
                    await conn.sendMessage(from, { 
                        text: `🌐 Bot mode set to: PUBLIC` 
                    }, { quoted: message });
                } else if (args[0] === 'private') {
                    BOT_MODE = "private";
                    adminData.mode = "private";
                    saveAdminData();
                    await conn.sendMessage(from, { 
                        text: `🔒 Bot mode set to: PRIVATE` 
                    }, { quoted: message });
                } else {
                    await conn.sendMessage(from, { 
                        text: `📊 Current bot mode: ${BOT_MODE.toUpperCase()}` 
                    }, { quoted: message });
                }
                return true;

            // Sudo management commands - CORRECTED
            case 'sudoadd':
            case 'addsudo':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                let targetUser = args[0];
                if (!targetUser) {
                    // Check for quoted message
                    const quoted = getQuotedMessage(message);
                    if (quoted) {
                        targetUser = quoted.sender;
                    } else {
                        await conn.sendMessage(from, { 
                            text: `❌ Please provide a user number or reply to a message\nUsage: ${userPrefix}sudoadd 237656274406` 
                        }, { quoted: message });
                        return true;
                    }
                }
                
                // Normalize the JID
                const normalizedTarget = targetUser.replace(/\D/g, "") + '@s.whatsapp.net';
                
                if (adminData.sudoUsers.includes(normalizedTarget)) {
                    await conn.sendMessage(from, { 
                        text: `❌ User is already a sudo user` 
                    }, { quoted: message });
                    return true;
                }
                
                adminData.sudoUsers.push(normalizedTarget);
                saveAdminData();
                await conn.sendMessage(from, { 
                    text: `✅ Added ${normalizedTarget} to sudo users` 
                }, { quoted: message });
                return true;

            case 'sudoremove':
            case 'removesudo':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                let removeTarget = args[0];
                if (!removeTarget) {
                    const quoted = getQuotedMessage(message);
                    if (quoted) {
                        removeTarget = quoted.sender;
                    } else {
                        await conn.sendMessage(from, { 
                            text: `❌ Please provide a user number or reply to a message\nUsage: ${userPrefix}sudoremove 237656274406` 
                        }, { quoted: message });
                        return true;
                    }
                }
                
                const normalizedRemoveTarget = removeTarget.replace(/\D/g, "") + '@s.whatsapp.net';
                
                if (!adminData.sudoUsers.includes(normalizedRemoveTarget)) {
                    await conn.sendMessage(from, { 
                        text: `❌ User is not a sudo user` 
                    }, { quoted: message });
                    return true;
                }
                
                adminData.sudoUsers = adminData.sudoUsers.filter(user => user !== normalizedRemoveTarget);
                saveAdminData();
                await conn.sendMessage(from, { 
                    text: `✅ Removed ${normalizedRemoveTarget} from sudo users` 
                }, { quoted: message });
                return true;

            case 'ban':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                let banTarget = args[0];
                if (!banTarget) {
                    const quoted = getQuotedMessage(message);
                    if (quoted) {
                        banTarget = quoted.sender;
                    } else {
                        await conn.sendMessage(from, { 
                            text: `❌ Please provide a user number or reply to a message\nUsage: ${userPrefix}ban 237656274406` 
                        }, { quoted: message });
                        return true;
                    }
                }
                
                const normalizedBanTarget = banTarget.replace(/\D/g, "") + '@s.whatsapp.net';
                
                if (adminData.bannedUsers.includes(normalizedBanTarget)) {
                    await conn.sendMessage(from, { 
                        text: `❌ User is already banned` 
                    }, { quoted: message });
                    return true;
                }
                
                adminData.bannedUsers.push(normalizedBanTarget);
                saveAdminData();
                await conn.sendMessage(from, { 
                    text: `✅ Banned ${normalizedBanTarget}` 
                }, { quoted: message });
                return true;

            case 'unban':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only roan md v3` 
                    }, { quoted: message });
                    return true;
                }
                
                let unbanTarget = args[0];
                if (!unbanTarget) {
                    const quoted = getQuotedMessage(message);
                    if (quoted) {
                        unbanTarget = quoted.sender;
                    } else {
                        await conn.sendMessage(from, { 
                            text: `❌ Please provide a user number or reply to a message\nUsage: ${userPrefix}unban 237656274406` 
                        }, { quoted: message });
                        return true;
                    }
                }
                
                const normalizedUnbanTarget = unbanTarget.replace(/\D/g, "") + '@s.whatsapp.net';
                
                if (!adminData.bannedUsers.includes(normalizedUnbanTarget)) {
                    await conn.sendMessage(from, { 
                        text: `❌ User is not banned` 
                    }, { quoted: message });
                    return true;
                }
                
                adminData.bannedUsers = adminData.bannedUsers.filter(user => user !== normalizedUnbanTarget);
                saveAdminData();
                await conn.sendMessage(from, { 
                    text: `✅ Unbanned ${normalizedUnbanTarget}` 
                }, { quoted: message });
                return true;

            case 'active':
                // CORRECTED: Now properly checks if user is dev
                if (!isDev(senderJid)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Developer only` 
                    }, { quoted: message });
                    return true;
                }
                
                await conn.sendMessage(from, { 
                    text: `📊 Active Connections: ${activeSockets}\n👥 Total Users: ${totalUsers}` 
                }, { quoted: message });
                return true;

            case 'setdev':
                // Only current dev can set new dev
                if (!isDev(senderJid)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Current developer only` 
                    }, { quoted: message });
                    return true;
                }
                
                const newDev = args[0];
                if (!newDev) {
                    await conn.sendMessage(from, { 
                        text: `❌ Please provide a developer number\nUsage: ${userPrefix}setdev 237656274406` 
                    }, { quoted: message });
                    return true;
                }
                
                const normalizedNewDev = newDev.replace(/\D/g, "") + '@s.whatsapp.net';
                adminData.dev = normalizedNewDev;
                saveAdminData();
                await conn.sendMessage(from, { 
                    text: `✅ Developer set to: ${normalizedNewDev}` 
                }, { quoted: message });
                return true;

            case 'joingroup':
                if (!isOwner(senderJid, conn)) {
                    await conn.sendMessage(from, { 
                        text: `❌ Owner only queen akuma` 
                    }, { quoted: message });
                    return true;
                }
                
                const groupInvite = args[0];
                if (!groupInvite) {
                    await conn.sendMessage(from, { 
                        text: `❌ Please provide a group invite code or link\nUsage: ${userPrefix}joingroup EcOPWEvs03f0iLCk4wradO` 
                    }, { quoted: message });
                    return true;
                }
                
                try {
                    let inviteCode = groupInvite;
                    if (groupInvite.includes('chat.whatsapp.com/')) {
                        inviteCode = groupInvite.split('/').pop();
                    }
                    
                    inviteCode = inviteCode.replace('@g.us', '');
                    
                    if (conn.groupAcceptInvite) {
                        const result = await conn.groupAcceptInvite(inviteCode);
                        await conn.sendMessage(from, { 
                            text: `✅ Successfully joined group: ${inviteCode}` 
                        }, { quoted: message });
                    } else {
                        await conn.sendMessage(from, { 
                            text: `❌ Group join method not available` 
                        }, { quoted: message });
                    }
                } catch (error) {
                    await conn.sendMessage(from, { 
                        text: `❌ Failed to join group: ${error.message}` 
                    }, { quoted: message });
                }
                return true;
                
            default:
                return false;
        }
    } catch (error) {
        console.error("Error in handleBuiltInCommands:", error);
        return false;
    }
}

// Setup connection event handlers
function setupConnectionHandlers(conn, sessionId, io, saveCreds) {
    let hasShownConnectedMessage = false;
    let isLoggedOut = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    
    // Setup newsletter auto-react handler
    setupNewsletterHandlers(conn);
    
    // Handle connection updates
    conn.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        console.log(`Connection update for ${sessionId}:`, connection, qr ? 'QR received' : '');
        
        // If QR code is received, we're not connected
        if (qr) {
            console.log(`📱 QR Code received for ${sessionId}, waiting for scan...`);
            hasShownConnectedMessage = false;
            return;
        }
        
        if (connection === "open") {
            console.log(`✅ WhatsApp CONNECTED for session: ${sessionId}`);
            console.log(`🟢 ACTIVE — ${BOT_NAME} is now online for ${sessionId}`);
            
            isUserLoggedIn = true;
            isLoggedOut = false;
            reconnectAttempts = 0;
            activeSockets++;
            broadcastStats();
            
            // Send connected event to frontend
            io.emit("linked", { sessionId });
            
            if (!hasShownConnectedMessage) {
                hasShownConnectedMessage = true;
                
                setTimeout(async () => {
                    try {
                        // Auto-join configured groups
                        const joinResults = await autoJoinGroups(conn);
                        joinResults.forEach(result => {
                            if (result.success) {
                                console.log(`✅ Auto-joined group: ${result.group}`);
                            } else {
                                console.log(`❌ Failed to auto-join group: ${result.group}`);
                            }
                        });

                        const subscriptionResults = await subscribeToChannels(conn);
                        
                        let channelStatus = "";
                        subscriptionResults.forEach((result, index) => {
                            const status = result.success ? "✅ Followed" : "❌ Not followed";
                            channelStatus += `📢 Channel ${index + 1}: ${status}\n`;
                        });

                        let name = "User";
                        try {
                            name = conn.user.name || "User";
                        } catch (error) {
                            console.log("Could not get user name:", error.message);
                        }
                        
                        let up = `
╭───『 ${BOT_NAME} 』
│
│ 🌹 *ʜᴇʏ ${name}*
│ 🌹 *ᴛʜᴀɴᴋs ғᴏʀ ᴜsɪɴɢ ᴍᴇ*
│ 🌹 *ᴍʀ ʀᴏᴀɴ*
│ ⚕️ *ᴘʀᴇғɪx : ${PREFIX}*
│
╰─────────────-─────
                        `;

                        // Send welcome message to user's DM with proper JID format and requested style
                        const userJid = `${conn.user.id.split(":")[0]}@s.whatsapp.net`;
                        await conn.sendMessage(userJid, { 
                            text: up,
                            contextInfo: {
                                mentionedJid: [userJid],
                                forwardingScore: 999,
                                externalAdReply: {
                                    title: `${BOT_NAME} Connected 🚀`,
                                    body: `ᴍᴀᴅᴇ ʙʏ ${OWNER_NAME}`,
                                    thumbnailUrl: MENU_IMAGE_URL,
                                    mediaType: 1,
                                    renderLargerThumbnail: true
                                }
                            }
                        });
                        
                        console.log(`✅ Welcome message sent to ${userJid}`);
                    } catch (error) {
                        console.error("Error in channel subscription or welcome message:", error);
                    }
                }, 2000);
            }
        }
        
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`🔌 Connection closed for ${sessionId}, status: ${statusCode}, shouldReconnect: ${shouldReconnect}`);
            
            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                console.log(`🔁 Attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} for ${sessionId}`);
                
                // Reset to allow new QR if needed
                hasShownConnectedMessage = false;
                
                const delay = reconnectAttempts * 5000; // 5s, 10s, 15s
                setTimeout(() => {
                    if (activeConnections.has(sessionId)) {
                        console.log(`🔄 Executing reconnect attempt ${reconnectAttempts} for ${sessionId}`);
                        initializeConnection(sessionId);
                    }
                }, delay);
            } else {
                console.log(`🔒 Final disconnect for session: ${sessionId}`);
                isUserLoggedIn = false;
                isLoggedOut = true;
                activeSockets = Math.max(0, activeSockets - 1);
                broadcastStats();
                
                // ONLY delete session folder when user logs out (DisconnectReason.loggedOut)
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`🗑️ User logged out, cleaning session: ${sessionId}`);
                    setTimeout(() => {
                        cleanupSession(sessionId, true);
                    }, 3000);
                } else {
                    console.log(`📁 Keeping session for ${sessionId} (non-logout disconnect)`);
                }
                
                activeConnections.delete(sessionId);
                io.emit("unlinked", { sessionId });
            }
        }
        
        // Handle "connecting" state
        if (connection === "connecting") {
            console.log(`🔄 Connecting... for session: ${sessionId}`);
            hasShownConnectedMessage = false;
        }
    });

    // Handle credentials updates
    conn.ev.on("creds.update", async () => {
        if (saveCreds) {
            try {
                await saveCreds();
                console.log(`💾 Credentials saved for ${sessionId}`);
            } catch (error) {
                console.error(`❌ Error saving credentials for ${sessionId}:`, error);
            }
        }
    });

    // Handle messages
        conn.ev.on("messages.upsert", async (m) => {
        try {
            const message = m.messages[0];
            
            // Get the bot's JID in proper format
            const botJid = conn.user.id;
            const normalizedBotJid = botJid.includes(':') ? botJid.split(':')[0] + '@s.whatsapp.net' : botJid;
            
            // Check if message is from the bot itself (owner)
            const isFromBot = message.key.fromMe || 
                              (message.key.participant && message.key.participant === normalizedBotJid) ||
                              (message.key.remoteJid && message.key.remoteJid === normalizedBotJid);
            
            // Don't process messages sent by the bot unless they're from the owner account
            if (message.key.fromMe && !isFromBot) return;
            
            console.log(`📩 Received message from ${message.key.remoteJid}, fromMe: ${message.key.fromMe}, isFromBot: ${isFromBot}`);
            
            // Handle all message types (private, group, newsletter)
            const from = message.key.remoteJid;
            
            // Check if it's a newsletter message
            if (from.endsWith('@newsletter')) {
                await handleMessage(conn, message, sessionId);
            } 
            // Check if it's a group message
            else if (from.endsWith('@g.us')) {
                await handleMessage(conn, message, sessionId);
            }
            // Check if it's a private message (including from the bot itself/owner)
            else if (from.endsWith('@s.whatsapp.net') || isFromBot) {
                await handleMessage(conn, message, sessionId);
            }
            
            // Added message printing for better debugging
            const messageType = getMessageType(message);
            let messageText = getMessageText(message, messageType);
            
            if (!message.key.fromMe || isFromBot) {
                const timestamp = new Date(message.messageTimestamp * 1000).toLocaleTimeString();
                const isGroup = from.endsWith('@g.us');
                const sender = message.key.fromMe ? conn.user.id : (message.key.participant || message.key.remoteJid);
                
                if (isGroup) {
                    console.log(`[${timestamp}] [GROUP: ${from}] ${sender}: ${messageText} (${messageType})`);
                } else {
                    console.log(`[${timestamp}] [PRIVATE] ${sender}: ${messageText} (${messageType})`);
                }
            }
        } catch (error) {
            console.error("Error processing message:", error);
        }
    });

    // Auto View Status feature
    conn.ev.on("messages.upsert", async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.key.fromMe && msg.key.remoteJid === "status@broadcast") {
                await conn.readMessages([msg.key]);
                console.log("✅ Auto-viewed a status.");
            }
        } catch (e) {
            console.error("❌ AutoView failed:", e);
        }
    });

    // Auto Like Status feature
    conn.ev.on("messages.upsert", async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.key.fromMe && msg.key.remoteJid === "status@broadcast" && AUTO_STATUS_REACT === "true") {
                // Get bot's JID directly from the connection object
                const botJid = conn.user.id;
                const emojis = ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '😄', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '🇳🇬', '💜', '💙', '🌝', '🖤', '💚'];
                const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
                
                await conn.sendMessage(msg.key.remoteJid, {
                    react: {
                        text: randomEmoji,
                        key: msg.key,
                    } 
                }, { statusJidList: [msg.key.participant, botJid] });
                
                // Print status update in terminal with emoji
                const timestamp = new Date().toLocaleTimeString();
                console.log(`[${timestamp}] ✅ Auto-liked a status with ${randomEmoji} emoji`);
            }
        } catch (e) {
            console.error("❌ AutoLike failed:", e);
        }
    });
}

// Function to reinitialize connection
async function initializeConnection(sessionId) {
    try {
        console.log(`🔄 Initializing connection for session: ${sessionId}`);
        
        const sessionDir = path.join(__dirname, "sessions", sessionId);
        
        if (!fs.existsSync(sessionDir)) {
            console.log(`❌ Session directory not found for ${sessionId}`);
            return;
        }

        // Check if credentials exist
        const credsPath = path.join(sessionDir, "creds.json");
        if (!fs.existsSync(credsPath)) {
            console.log(`❌ No credentials found for ${sessionId}, need new pairing`);
            return;
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const conn = makeWASocket({
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            version,
            browser: Browsers.macOS("Safari"),
            connectTimeoutMs: 30000, // Reduced timeout
            keepAliveIntervalMs: 15000, // Reduced interval
            maxIdleTimeMs: 30000,
            maxRetries: 5,
            markOnlineOnConnect: true,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 30000,
            syncFullHistory: false
        });

        activeConnections.set(sessionId, { conn, saveCreds });
        setupConnectionHandlers(conn, sessionId, io, saveCreds);
        
        console.log(`✅ Connection initialization completed for ${sessionId}`);
        
    } catch (error) {
        console.error(`❌ Error reinitializing connection for ${sessionId}:`, error);
        
        // In case of error, clean up connection
        if (activeConnections.has(sessionId)) {
            activeConnections.delete(sessionId);
        }
    }
}

// Clean up session folder (ONLY delete on logout)
function cleanupSession(sessionId, deleteEntireFolder = false) {
    const sessionDir = path.join(__dirname, "sessions", sessionId);
    
    if (fs.existsSync(sessionDir)) {
        if (deleteEntireFolder) {
            // ONLY delete if it's a logout (DisconnectReason.loggedOut)
            fs.rmSync(sessionDir, { recursive: true, force: true });
            console.log(`🗑️ Deleted session folder due to logout: ${sessionId}`);
        } else {
            // Regular cleanup - DO NOT delete anything, just log
            console.log(`📁 Session preservation: Keeping all files for ${sessionId}`);
        }
    }
}

// API endpoint to get loaded commands
app.get("/api/commands", (req, res) => {
    const commandList = Array.from(commands.keys());
    res.json({ commands: commandList });
});

// Socket.io connection handling
io.on("connection", (socket) => {
    console.log("🔌 Client connected:", socket.id);
    
    socket.on("disconnect", () => {
        console.log("❌ Client disconnected:", socket.id);
    });
    
    socket.on("force-request-qr", () => {
        console.log("QR code regeneration requested");
    });
});

// Session preservation routine - NO AUTOMATIC CLEANUP
setInterval(() => {
    const sessionsDir = path.join(__dirname, "sessions");
    
    if (!fs.existsSync(sessionsDir)) return;
    
    const sessions = fs.readdirSync(sessionsDir);
    const now = Date.now();
    
    sessions.forEach(session => {
        const sessionPath = path.join(sessionsDir, session);
        const stats = fs.statSync(sessionPath);
        const age = now - stats.mtimeMs;
        
        // Log session age but DO NOT DELETE anything
        if (age > 5 * 60 * 1000 && !activeConnections.has(session)) {
            console.log(`📊 Session ${session} is ${Math.round(age/60000)} minutes old - PRESERVED`);
            // Intentionally do nothing - preserve all sessions
        }
    });
}, 5 * 60 * 1000); // Run every 5 minutes but only for logging

// Function to reload existing sessions on server restart
async function reloadExistingSessions() {
    console.log("🔄 Checking for existing sessions to reload...");
    
    const sessionsDir = path.join(__dirname, "sessions");
    
    if (!fs.existsSync(sessionsDir)) {
        console.log("📁 No sessions directory found, skipping session reload");
        return;
    }
    
    const sessions = fs.readdirSync(sessionsDir);
    console.log(`📂 Found ${sessions.length} session directories`);
    
    for (const sessionId of sessions) {
        const sessionDir = path.join(sessionsDir, sessionId);
        const stat = fs.statSync(sessionDir);
        
        if (stat.isDirectory()) {
            console.log(`🔄 Attempting to reload session: ${sessionId}`);
            
            try {
                // Check if this session has valid auth state (creds.json)
                const credsPath = path.join(sessionDir, "creds.json");
                if (fs.existsSync(credsPath)) {
                    await initializeConnection(sessionId);
                    console.log(`✅ Successfully reloaded session: ${sessionId}`);
                    
                    // Count this as an active socket but don't increment totalUsers
                    activeSockets++;
                    console.log(`📊 Active sockets increased to: ${activeSockets}`);
                } else {
                    console.log(`❌ No valid auth state found for session: ${sessionId}`);
                    // Clean up invalid session (only creds.json missing, keep folder)
                    console.log(`📁 Keeping session folder for potential reuse: ${sessionId}`);
                }
            } catch (error) {
                console.error(`❌ Failed to reload session ${sessionId}:`, error.message);
                // Don't delete the session folder, keep it for manual inspection
                console.log(`📁 Preserving session folder despite error: ${sessionId}`);
            }
        }
    }
    
    console.log("✅ Session reload process completed");
    broadcastStats(); // Update stats after reloading all sessions
}

// Start the server
server.listen(port, async () => {
    console.log(`🚀 ${BOT_NAME} server running on http://localhost:${port}`);
    console.log(`📱 WhatsApp bot initialized`);
    console.log(`🔧 Loaded ${commands.size} commands`);
    console.log(`📊 Starting with ${totalUsers} total users (persistent)`);
    console.log(`👑 Bot mode: ${BOT_MODE.toUpperCase()}`);
    console.log(`🔧 Auto-status features: Seen=${AUTO_STATUS_SEEN}, React=${AUTO_STATUS_REACT}, Reply=${AUTO_STATUS_REPLY}`);
    console.log(`📢 Newsletter auto-react: ${AUTO_NEWSLETTER_REACT}`);
    console.log(`🤝 Auto-join groups: ${AUTO_JOIN_GROUPS.length} groups configured`);
    
    // Reload existing sessions after server starts
    await reloadExistingSessions();
});

// Graceful shutdown
let isShuttingDown = false;

function gracefulShutdown() {
  if (isShuttingDown) {
    console.log("🛑 Shutdown already in progress...");
    return;
  }
  
  isShuttingDown = true;
  console.log("\n🛑 Shutting down queen akuma server...");
  
  // Save persistent data before shutting down
  savePersistentData();
  saveAdminData();
  console.log(`💾 Saved persistent data: ${totalUsers} total users`);
  
  let connectionCount = 0;
  activeConnections.forEach((data, sessionId) => {
    try {
      data.conn.ws.close();
      console.log(`🔒 Closed WhatsApp connection for session: ${sessionId}`);
      connectionCount++;
    } catch (error) {}
  });
  
  console.log(`✅ Closed ${connectionCount} WhatsApp connections`);
  console.log(`📁 All session folders preserved for next server start`);
  
  const shutdownTimeout = setTimeout(() => {
    console.log("⚠️  Force shutdown after timeout");
    process.exit(0);
  }, 3000);
  
  server.close(() => {
    clearTimeout(shutdownTimeout);
    console.log("✅ Server shut down gracefully");
    console.log("📁 Session folders preserved - they will be reloaded on next server start");
    process.exit(0);
  });
}

// Handle termination signals
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT signal");
  gracefulShutdown();
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM signal");
  gracefulShutdown();
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error.message);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});
