const { Webhook } = require('discord-webhook-node');
const hook = new Webhook("https://discord.com/api/webhooks/920019522277236808/N8Dv7wlh5zUNu9l1fn5xoCvg1DAYJLO7syxxVnWpOwHasVPmmKZ-E_QlQbpe6DCaYeSB");
 
const IMAGE_URL = 'https://www.euler.finance/static/media/EF_logo__Euler_finance_euler-bg.2fc2705c.svg';
hook.setUsername('Euler Liquidation BOT');
hook.setAvatar(IMAGE_URL);
 
module.exports = (alert) => {
    if(process.env.DISCORD_ENABLED === 'true') hook.send(alert);
}