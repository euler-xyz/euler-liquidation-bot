const WebSocket = require('ws');
const {enablePatches, applyPatches} = require('immer');
const et = require('euler-contracts/test/lib/eTestLib.js');
const hre = require('hardhat');

const strategies = require('./strategies');
const EulerToolClient = require('./EulerToolClient.js');
const { cartesian } = require('./utils');
const monConfig = require('../mon.config')[hre.network.name];

enablePatches();

let subsData = {};
let showLogs;
let ctx;


// TODO signers and owner
// TODO EOA liquidation - checkLiquidation is async
// TODO transfer all balance in bot

async function main() {
    config(await et.getTaskCtx()); // TODO extend with additional contracts (LiquidationBot) 

    doConnect();
}

async function config(context, logs = true) {
    showLogs = logs;
    ctx = context;
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
                   endpoint: monConfig.eulerscan.ws,
                   WebSocket,
                   onConnect: () => {
                       log("CONNECTED");
                   },
                   onDisconnect: () => {
                       log("ORDERBOOK DISCONNECT");
                       subsData = {};
                   },
                });

    ec.sub({
        query: {
            topic: "accounts",
            by: "healthScore",
            healthMax: monConfig.eulerscan.healthMax || 15000000,
            limit: monConfig.eulerscan.queryLimit || 10
        },
    }, (err, patch) => {
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
                log("VIOLATION DETECTED", act.account, act.healthScore);
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
    const activeStrategies = [strategies.EOASwapAndRepay]; // TODO config
    const collaterals = act.markets.filter(m => m.liquidityStatus.collateralValue !== '0');
    const underlyings = act.markets.filter(m => m.liquidityStatus.liabilityValue !== '0');


    // TODO all settled?
    const opportunities = await Promise.all(
        cartesian(collaterals, underlyings, activeStrategies).map(
            async ([collateral, underlying, Strategy]) => {
                const strategy = new Strategy(act, collateral, underlying, ctx);
                await strategy.findBest();
                return strategy;
            }
        )
    );

    // console.log('opportunities: ', opportunities);
    const bestStrategy = opportunities.reduce((accu, o) => {
        return o.best && o.best.yield.gt(accu.best.yield) ? o : accu;
    }, { best: { yield: 0 }});
    
    if (bestStrategy.best.yield === 0) throw `No liquidation opportunity found for ${act.account}`;

    console.log('EXECUTING BEST STRATEGY');
    bestStrategy.logBest();

    await bestStrategy.exec();
}


module.exports = {
    main,
    process,
    config,
    setData,
}