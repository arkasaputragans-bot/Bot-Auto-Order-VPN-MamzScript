const axios = require('axios');

function cleanDomain(dom) {
    if (!dom) return '';
    return dom.replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
}

async function createRailwayAccount(rawDomain, authKey, username, expDays, protocol = 'vmess') {
    const domain = cleanDomain(rawDomain);
    const url = `https://${domain}/api/create`;
    const proto = protocol.toLowerCase();

    const payload = {
        username: username,
        exp: parseInt(expDays),
        protocol: proto
    };

    const res = await axios.post(url, payload, {
        headers: {
            'Authorization': `Bearer ${authKey.trim()}`,
            'Content-Type': 'application/json'
        },
        timeout: 25000
    });

    if (res.data && res.data.status) {
        const d = res.data.data;
        const expDate = d.exp ? d.exp.split(' ')[0] : `${expDays} Hari`;
        const protoUpper = proto.toUpperCase();

        let resultText = `🎉 *AKUN ${protoUpper} BERHASIL DIBUAT!*\n━━━━━━━━━━━━━━━━━━\n`;
        resultText += `👤 *Username:* \`${d.username}\`\n`;
        resultText += `🔑 *UUID:* \`${d.uuid}\`\n`;
        resultText += `🌐 *Domain/SNI:* \`${d.domain}\`\n`;
        resultText += `🚪 *Port TLS:* \`443\`\n`;
        resultText += `⚡ *Network:* \`WebSocket (WS)\`\n`;
        resultText += `🛣️ *Path:* \`/${proto}-railway\`\n`;
        resultText += `📅 *Expired:* \`${expDate}\`\n━━━━━━━━━━━━━━━━━━\n`;
        resultText += `📌 *Link ${protoUpper}:*\n\`${d.active_link}\`\n━━━━━━━━━━━━━━━━━━\n`;
        resultText += `_Silakan salin link di atas lalu import ke v2rayNG / Streisand / V2RayN._`;

        return resultText;
    } else {
        throw new Error((res.data && res.data.message) || 'Gagal membuat akun di server Railway.');
    }
}

async function renewRailwayAccount(rawDomain, authKey, username, expDays) {
    const domain = cleanDomain(rawDomain);
    const url = `https://${domain}/api/renew`;
    const res = await axios.post(url, { username, exp: parseInt(expDays) }, {
        headers: { 
            'Authorization': `Bearer ${authKey.trim()}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    if (res.data && res.data.status) {
        return `✅ *PERPANJANG BERHASIL!*\nAkun \`${username}\` aktif hingga: \`${res.data.exp}\``;
    }
    throw new Error((res.data && res.data.message) || "Gagal perpanjang akun.");
}

module.exports = { createRailwayAccount, renewRailwayAccount };
