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

module.exports = {
  cartesian,
  filterOutRejected,
  c1e18,
}