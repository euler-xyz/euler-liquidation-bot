const et = require('euler-contracts/test/lib/eTestLib.js');
const { setData, process } = require('../../scripts/monLib');

const deploy = async (ctx) => {
  const liquidationBotFactory = await ethers.getContractFactory('LiquidationBot');
  ctx.contracts.liquidationBot = await (await liquidationBotFactory.deploy()).deployed();
};


const runConnector = async (ctx) => {
  const eulerscanData = async accounts => {
    const res = await ctx.contracts.eulerGeneralView.callStatic.doQueryBatch(accounts.map(account => ({
      eulerContract: ctx.contracts.euler.address,
      account,
      markets: [],
    })));

    const collateralValue = m => m.eTokenBalanceUnderlying.mul(m.twap).div(et.units(1, m.decimals)).mul(m.config.collateralFactor).div(4e9);
    const liabilityValue = m => m.dTokenBalance.mul(m.twap).div(et.units(1, m.decimals)).mul(4e9).div(m.config.borrowFactor);
    return res.reduce((accu, r, i) => {
      const totalLiabilities = r.markets.reduce((accu, m) => liabilityValue(m).add(accu), ethers.BigNumber.from(0));
      const healthScore = totalLiabilities.eq(0)
        ? '10000000'
        : r.markets.reduce((accu, m) => collateralValue(m).add(accu), 0)
          .mul(1e6)
          .div(totalLiabilities)
          .toString();

      accu.accounts.accounts[String(i + 1)] = {
        account: accounts[i],
        healthScore,
        markets: r.markets.map(m => ({
          liquidityStatus: {
            liabilityValue: liabilityValue(m).toString(),
            collateralValue: collateralValue(m).toString(),
          },
          underlying: m.underlying,
          symbol: m.symbol
        })),
      };

      return accu;
    }, { accounts: { accounts: {} }});
  };

  const data = await eulerscanData([ctx.wallet.address, ctx.wallet2.address]);

  setData(data);
  await process();
}

module.exports = {
  deploy,
  runConnector,
}