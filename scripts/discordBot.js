const { Webhook } = require('discord-webhook-node');
let hook;
const hookUrl = process.env.DISCORD_WEBHOOK;

if (hookUrl) {
    hook = new Webhook(hookUrl)
    hook.setUsername('Euler Liquidation BOT');
}

module.exports = (alert) => {
    if (hook) return hook.send(alert);
}