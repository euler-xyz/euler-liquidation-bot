const { Webhook } = require('discord-webhook-node');
const hook = new Webhook(process.env.DISCORD_HOOK);
 
const IMAGE_URL = 'https://www.euler.finance/static/media/EF_logo__Euler_finance_euler-bg.2fc2705c.svg';
hook.setUsername('Euler Liquidation BOT');
hook.setAvatar(IMAGE_URL);
 
module.exports = (alert) => {
    if(process.env.DISCORD_ENABLED === 'true') hook.send(alert);
}