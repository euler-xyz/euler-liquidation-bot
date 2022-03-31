const { Webhook } = require('discord-webhook-node');
let hook;
const hookUrl = process.env.DISCORD_WEBHOOK;
const avatarUrl = process.env.DISCORD_AVATAR_URL

if (hookUrl) {
    hook = new Webhook(hookUrl)
    hook.setUsername('Euler Liquidation BOT');
    if (avatarUrl) hook.setAvatar(avatarUrl);
}

module.exports = (alert) => {
    if (hook) hook.send(alert);
}