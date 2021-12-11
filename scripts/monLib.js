const WebSocket = require('ws');
const {enablePatches, applyPatches} = require('immer');

const strategies = require('./strategies');
const EulerToolClient = require('./EulerToolClient.js');
const { cartesian, filtreOutRejected } = require('./utils')

enablePatches();


let liquidationBotContract;
let eulerAddresses;
let subsData = {};
let showLogs;
let signer;


// TODO signers and owner
// TODO EOA liquidation - checkLiquidation is async
// TODO transfer all balance in bot

async function main() {
    let factory = await ethers.getContractFactory('LiquidationBot');
    config(
        await (await factory.deploy()).deployed(),
        require('euler-contracts/euler-addresses.json'),
    )
    console.log("liq bot contract deployed:", liquidationBotContract.address);

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

    ec.sub({ query: { topic: "accounts", by: "healthScore", healthMax: 15000000} }, (err, patch) => {
        // log('patch: ', JSON.stringify(patch, null, 2));
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
                log("VIOLATION DETECTED", act.account,act.healthScore);
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
    console.log('strategies: ', strategies);
    const activeStrategies = [strategies.EOASwapAndRepay]; // TODO config
    console.log('activeStrategies: ', activeStrategies);
    const collaterals = act.markets.filter(m => m.liquidityStatus.collateralValue !== '0');
    const underlyings = act.markets.filter(m => m.liquidityStatus.liabilityValue !== '0');


    // console.log('cartesian(collateral, liabilities): ', cartesian(collaterals, underlyings));

    // TODO all settled?
    const opportunities = await Promise.all(
        cartesian(collaterals, underlyings, activeStrategies).map(
            async ([collateral, underlying, Strategy]) => {
                console.log('Strategy: ', Strategy);
                const strategy = new Strategy(act, collateral, underlying, eulerAddresses, liquidationBotContract);
                await strategy.findBest();
                return strategy;
            }
        )
    );

    // console.log('opportunities: ', opportunities);
    const bestStrategy = opportunities.reduce((accu, o) => {
        return o.best && o.best.yield.gt(accu.yield) ? o : accu;
    }, { yield: 0});

    if (bestStrategy.best.yield === 0) throw `No liquidation opportunity found for ${act.account}`;

    console.log('EXECUTING BEST STRATEGY');
    bestStrategy.logBest();

    let res = await bestStrategy.exec();
    // console.log('res: ', res);
}


module.exports = {
    main,
    process,
    config,
    setData,
}