const et = require('euler-contracts/test/lib/eTestLib.js');

const provisionUniswapPool = (ctx, pool, wallet, amount, tickLower = -887220, tickUpper = 887220) => [
    { from: wallet, send: `tokens.${pool.split('/')[0]}.mint`, args: [wallet.address, amount.mul(1_000_001)], },
    { from: wallet, send: `tokens.${pool.split('/')[1]}.mint`, args: [wallet.address, amount.mul(1_000_001)], },

    { from: wallet, send: `tokens.${pool.split('/')[0]}.approve`, args: [ctx.contracts.simpleUniswapPeriphery.address, et.MaxUint256], },
    { from: wallet, send: `tokens.${pool.split('/')[1]}.approve`, args: [ctx.contracts.simpleUniswapPeriphery.address, et.MaxUint256], },

    { from: wallet, send: 'simpleUniswapPeriphery.mint', args: [ctx.contracts.uniswapPools[pool].address, wallet.address, tickLower, tickUpper, amount], },
];

const deposit = (ctx, token, wallet = ctx.wallet, subAccountId = 0, amount = 100, decimals = 18) => [
    { from: wallet, send: `tokens.${token}.mint`, args: [wallet.address, et.units(amount, decimals)], },
    { from: wallet, send: `tokens.${token}.approve`, args: [ctx.contracts.euler.address, et.MaxUint256,], },
    { from: wallet, send: `eTokens.e${token}.deposit`, args: [subAccountId, et.MaxUint256,], },
];

const deployBot = ctx => async () => {
    const liquidationBotFactory = await ethers.getContractFactory('LiquidationBot');
    ctx.contracts.liquidationBot = await (await liquidationBotFactory.deploy()).deployed()
};

module.exports = {
    provisionUniswapPool,
    deposit,
    deployBot,
};
