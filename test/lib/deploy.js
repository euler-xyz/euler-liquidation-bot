module.exports = async (ctx) => {
  const liquidationBotFactory = await ethers.getContractFactory('LiquidationBot');
  ctx.contracts.liquidationBot = await (await liquidationBotFactory.deploy()).deployed();
};