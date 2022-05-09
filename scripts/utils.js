const { BigNumber } = require('ethers');

const cartesian = (...a) => a.reduce((a, b) => a.flatMap(d => b.map(e => [d, e].flat())));

const filterOutRejected = (results, onErr) => results.map((r, i) => {
    if (r.status === 'rejected') {
        if (typeof onErr === 'function') onErr(i, r.reason);
        return null;
    }
    return r.value;
})
.filter(Boolean);

const c1e18 = BigNumber.from(10).pow(18);

const txOpts = async (provider) => {
  let opts = {};

  if (process.env.TX_FEE_MUL !== undefined) {
      let feeMul = parseFloat(process.env.TX_FEE_MUL);

      let feeData = await provider.getFeeData();

      opts.maxFeePerGas = BigNumber.from(Math.floor(feeData.maxFeePerGas.toNumber() * feeMul));
      opts.maxPriorityFeePerGas = BigNumber.from(Math.floor(feeData.maxPriorityFeePerGas.toNumber() * feeMul));
  }

  if (process.env.TX_NONCE !== undefined) {
      opts.nonce = parseInt(process.env.TX_NONCE);
  }

  if (process.env.TX_GAS_LIMIT !== undefined) {
      opts.gasLimit = parseInt(process.env.TX_GAS_LIMIT);
  }

  return opts;
};

module.exports = {
  cartesian,
  filterOutRejected,
  c1e18,
  txOpts,
}