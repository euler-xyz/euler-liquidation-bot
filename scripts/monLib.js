const WebSocket = require('ws');
const {enablePatches, applyPatches} = require('immer');
const { BigNumber, utils } = ethers

const EulerToolClient = require('./EulerToolClient.js');

enablePatches();


let liquidationBotContract;
let eulerAddresses;
let subsData = {};
let showLogs;
let signer;

const cartesian = (...a) => a.reduce((a, b) => a.flatMap(d => b.map(e => [d, e].flat())));
const filterResolved = (results, onErr) => results.map((r, i) => {
    if (r.status === 'rejected') {
        if (typeof onErr === 'function') onErr(i, r.reason);
        return null;
    }
    return r.value;
})
.filter(Boolean);

// TODO signers and owner
// TODO EOA liquidation - checkLiquidation is async
// TODO transfer all balance in bot

async function main() {
    let factory = await ethers.getContractFactory('LiquidationBot');
    config(
        await (await factory.deploy()).deployed(),
        require('euler-contracts/euler-addresses.json'),
    )
    log("liq bot contract deployed:", liquidationBotContract.address);

    doConnect();
}

function config(liqBot, addresses, logs = true) {
    liquidationBotContract = liqBot;
    eulerAddresses = addresses;
    showLogs = logs;
}

function setData(newData) {
    subsData = newData;
}

function log(...args) {
    if (showLogs) console.log(...args)
}


function doConnect() {
    let ec; ec = new EulerToolClient({
                   version: 'liqmon 1.0',
                   endpoint: 'ws://localhost:8900',
                   WebSocket,
                   onConnect: () => {
                       log("CONNECTED");
                   },
                   onDisconnect: () => {
                       log("ORDERBOOK DISCONNECT");
                       subsData = {};
                   },
                });

    ec.sub({ query: { topic: "accounts", by: "healthScore", } }, (err, patch) => {
        log('patch: ', JSON.stringify(patch, null, 2));
        if (err) {
            log(`ERROR from client: ${err}`);
            return;
        }

        for (let p of patch.result) p.path = p.path.split('/').filter(e => e !== '');
        
        setData({ accounts: applyPatches(subsData.accounts, patch.result) });
        process();
    });

    ec.connect();
}


let inFlight;

async function process() {
    if (inFlight) return;
    inFlight = true;

    try {
        for (let act of Object.values(subsData.accounts.accounts)) {
            if (typeof(act) !== 'object') continue;
            if (act.healthScore < 1000000) {
                log("VIOLATION DETECTED",act.account,act.healthScore);
                await doLiquidation(act);
                break;
            }
        }
    } catch (e) {
        console.log('PROCESS FAILED:', e);
    } finally {
        inFlight = false;
    }
}

async function doLiquidation(act) {
    const collaterals = act.markets.filter(m => m.liquidityStatus.collateralValue !== '0');
    const underlyings = act.markets.filter(m => m.liquidityStatus.liabilityValue !== '0');


    // console.log('cartesian(collateral, liabilities): ', cartesian(collaterals, underlyings));

    // TODO strategies
    // TODO all settled?
    const opportunities = await Promise.all(
        cartesian(collaterals, underlyings).map(async ([collateral, underlying]) => {
            return {
                collateral,
                underlying,
                ...await pickUniswapLiquidation(act, collateral, underlying)
            }
        })
    );

    // console.log('opportunities: ', opportunities);
    const best = opportunities.reduce((accu, o) => {
        return o.yield.gt(accu.yield) ? o : accu;
    }, { yield: 0});

    if (best.yield === 0) throw `No liquidation opportunity found for ${act.account}`;

    log(`DOING LIQUIDATION: repay ${best.underlying.symbol} for collateral ${best.collateral.symbol}`);

    doUniswapLiquidation(act, best.collateral, best.underlying, best.swapPath);
}

async function pickUniswapLiquidation(act, collateral, underlying) {
    const feeLevels = [500, 3000, 10000];
    let paths;

    if (collateral.underlying.toLowerCase() === eulerAddresses.tokens.WETH.toLowerCase()) {
        paths = feeLevels.map(fee => {
            return encodePath([collateral.underlying, underlying.underlying], [fee]);
        });
    } else {
        // TODO explosion! try auto router, sdk
        paths = cartesian(feeLevels, feeLevels).map(([feeIn, feeOut]) => {
            return encodePath([underlying.underlying, eulerAddresses.tokens.WETH, collateral.underlying], [feeIn, feeOut]);
        });
    }
    // console.log('paths: ', paths);

    let tests = await Promise.allSettled(
        paths.map(async (swapPath) => {
            return {
                swapPath,
                yield: await testUniswapLiquidation(act, collateral, underlying, swapPath)
            };
        })
    );

    // TODO retry failed or continue
    // console.log('tests: ', tests);
    
    tests = filterResolved(tests, (i, err) => {
        log(`Failed uniswap test ${act}, ${collateral.symbol} / ${underlying.symbol}: ${paths[i]} ${err}`)
    })


    const best = tests.reduce((accu, t) => {
        return t.yield.gt(accu.yield) ? t : accu;
    }, { swapPath: null, yield: 0 });

    console.log(`Best path c: ${collateral.symbol} u: ${underlying.symbol} yield: ${best.yield.toString()} ${best.swapPath}`);
    return best;
}

function uniswapLiquidationParams (act, collateral, underlying, swapPath) {
    return {
        eulerAddr: eulerAddresses.euler,
        liquidationAddr: eulerAddresses.liquidation,
        execAddr: eulerAddresses.exec,
        marketsAddr: eulerAddresses.markets,
        swapAddr: eulerAddresses.swap,

        swapPath,

        violator: act.account,
        underlying: underlying.underlying,
        collateral: collateral.underlying,
    }
}

async function doUniswapLiquidation(act, collateral, underlying, swapPath) {
    let tx = await liquidationBotContract.liquidate(
        uniswapLiquidationParams(act, collateral, underlying, swapPath)
    );

    let res = await tx.wait();
    log(res);
    return res;
}

async function testUniswapLiquidation(act, collateral, underlying, swapPath) {
    let res = await liquidationBotContract.callStatic.testLiquidation(
        uniswapLiquidationParams(act, collateral, underlying, swapPath)
    );
    console.log(`Uniswap test yield: ${res.toString()} ${act.account}, c: ${collateral.symbol}, u: ${underlying.symbol}, ${swapPath}'`);
    return res;
}



function encodePath(path, fees) {
  const FEE_SIZE = 3

  if (path.length != fees.length + 1) {
    throw new Error('path/fee lengths do not match')
  }

  let encoded = '0x'
  for (let i = 0; i < fees.length; i++) {
    // 20 byte encoding of the address
    encoded += path[i].slice(2)
    // 3 byte encoding of the fee
    encoded += fees[i].toString(16).padStart(2 * FEE_SIZE, '0')
  }
  // encode the final token
  encoded += path[path.length - 1].slice(2)

  return encoded.toLowerCase()
}


module.exports = {
    main,
    encodePath,
    process,
    config,
    setData,
}