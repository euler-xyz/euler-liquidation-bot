const cartesian = (...a) => a.reduce((a, b) => a.flatMap(d => b.map(e => [d, e].flat())));

const filterOutRejected = (results, onErr) => results.map((r, i) => {
    if (r.status === 'rejected') {
        if (typeof onErr === 'function') onErr(i, r.reason);
        return null;
    }
    return r.value;
})
.filter(Boolean);

module.exports = {
  cartesian,
  filterOutRejected,
}