module.exports = {
  pattern: "alive",
  desc: "Check if bot is online",
  category: "general",
  use: ".alive",
  filename: __filename,

  execute: async (conn, message, m, { from, reply, sender }) => {
    try {
      // Bot PP
      let botPp;
      try {
        botPp = await conn.profilePictureUrl(conn.user.id, "image");
      } catch {
        botPp = "https://d.uguu.se/COLSOBDn.jpg";
      }

      // System & uptime
      const os = require("os");
      const uptime = process.uptime();
      const days = Math.floor(uptime / 86400);
      const hours = Math.floor((uptime % 86400) / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);

      const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
      const usedMem = ((os.totalmem() - os.freemem()) / 1024 / 1024 / 1024).toFixed(1);

      const senderTag = "@" + sender.split("@")[0];
      const date = new Date().toLocaleString("fr-FR", { hour12: false });

      // Alive message
      const caption = `
╭───『 𝐒𝐘𝐒𝐓𝐄𝐌 𝐒𝐓𝐀𝐓𝐔𝐒 』
│ *ʙᴏᴛ : ʀᴏᴀɴ ᴍᴅ ᴠ3*
│ *ᴜᴘᴛɪᴍᴇ : ${days}ᴅ ${hours}ʜ ${minutes}ᴍ ${seconds}s*
│ *ᴜsᴇʀ : ${senderTag}*
│ *ᴅᴀᴛᴇ : ${date}*
╰────────────────────• 

⟢ *sʏsᴛᴇᴍ: ${os.type()} ${os.release()}*
⟢ *ᴄᴘᴜ: ${os.cpus().length} ᴄᴏʀᴇs*
⟢ *ʀᴀᴍ: ${usedMem}ɢʙ / ${totalMem}ɢʙ*

⟢ *sᴛᴀᴛᴜs: ✅ ᴏɴʟɪɴᴇ & ʀᴇᴀᴅʏ*
`.trim();

      await conn.sendMessage(from, {
        image: { url: botPp },
        caption,
        mentions: [sender]
      }, { quoted: message });

    } catch (error) {
      console.error("Alive error:", error);
      reply("❌ Unable to display system status.");
    }
  }
};
