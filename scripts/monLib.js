const WebSocket = require('ws');
const {enablePatches, applyPatches} = require('immer');
const et = require('euler-contracts/test/lib/eTestLib.js');
const hre = require('hardhat');
const discord = require('./discordBot');

const strategies = require('./strategies');
const EulerToolClient = require('./EulerToolClient.js');
const { cartesian } = require('./utils');
const monConfig = require('../bot.config')[hre.network.name];

enablePatches();

let subsData = {};
let showLogs;
let ctx;

let deferredAccounts = {}

// TODO signers and owner
// TODO EOA liquidation - checkLiquidation is async
// TODO transfer all balance in bot
// TODO process accounts in parallel
// TODO improve gaslimit handling

async function main() {
    config(await et.getTaskCtx()); // TODO extend with additional contracts (LiquidationBot)

    let designatedAccount = process.env.LIQUIDATE_ACCOUNT
    if (designatedAccount) {
        console.log(`ATTEMPTING LIQUIDATION OF DESIGNATED ACCOUNT ${designatedAccount}`)
        await liquidateDesignatedAccount(designatedAccount);
        process.exit(0);
    }
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
        console.log('patch');
        if (err) {
            log(`ERROR from client: ${err}`);
            return;
        }

        for (let p of patch.result) p.path = p.path.split('/').filter(e => e !== '');
        
        setData({ accounts: applyPatches(subsData.accounts, patch.result) });
        processAccounts();
    });

    ec.connect();
}


let inFlight;

async function processAccounts() {
    if (inFlight) return;
    inFlight = true;
    let processedAccount;
    try {
        for (let act of Object.values(subsData.accounts.accounts)) {
            if (typeof(act) !== 'object') continue;

            processedAccount = act;
            if (act.healthScore < 1000000) {
                console.log('deferredAccounts[act.account] : ', deferredAccounts[act.account], Date.now() );
                if (deferredAccounts[act.account] && deferredAccounts[act.account].until > Date.now()) {
                    console.log(`Skipping deferred ${act.account}`);
                    continue;
                }

                log("VIOLATION DETECTED", act.account, act.healthScore);
                discord(`VIOLATION DETECTED account: ${act.account} health: ${act.healthScore / 1000000}}`);
                await doLiquidation(act);
                break;
            }
        }
    } catch (e) {
        console.log('PROCESS FAILED:', e);
        discord('PROCESS FAILED:', e.message);
        discord(`Deferring ${processedAccount.account} for 5 minutes`);
        deferAccount(processedAccount.account, 5 * 60000);
    } finally {
        inFlight = false;
    }
}

async function liquidateDesignatedAccount(violator) {
    let account = await getAccountLiquidity(violator);

    console.log(`Account ${violator} health = ${ethers.utils.formatEther(account.healthScore)}`);
    if (account.healthScore.gte(et.c1e18)) {
        console.log(`  Account not in violation.`);
        return;
    }

    await doLiquidation(account);
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

    if (bestStrategy.best.yield === 0) {
        deferAccount(act.account, 5 * 60000)
        let msg = `No liquidation opportunity found for ${act.account}. Deferring for 5 minutes`;
        discord(msg);
        console.log(msg);
        return false;
    }

    if (bestStrategy.best.yield.lt(ethers.utils.parseEther('0.05'))) {
        deferAccount(act.account, 10 * 60000)
        let msg = `Yield too low for ${act.account} (${ethers.utils.formatEther(bestStrategy.best.yield)} ETH, required 0.05). Deferring for 10 minutes`;
        discord(msg);
        console.log(msg);
        return false;
    }

    console.log('EXECUTING');
    bestStrategy.logBest();
    let tx = await bestStrategy.exec();

    discord(`LIQUIDATION COMPLETED: ${tx.transactionHash}`);

    let wallet = (await ethers.getSigners())[0];
    let botEthBalance = await ethers.provider.getBalance(wallet.address)
    let msg = `ETH BALANCE LEFT: ${ethers.utils.formatEther(botEthBalance)} ETH`;
    console.log(msg);
    discord(msg);
    return true;
}

async function getAccountLiquidity(account) {
    let detLiq = await ctx.contracts.exec.callStatic.detailedLiquidity(account);

    let markets = [];

    let totalLiabilities = ethers.BigNumber.from(0);
    let totalAssets = ethers.BigNumber.from(0);

    for (let asset of detLiq) {
        totalLiabilities = totalLiabilities.add(asset.status.liabilityValue);
        totalAssets = totalAssets.add(asset.status.collateralValue);

        markets.push({ 
            liquidityStatus: {
                liabilityValue: asset.status.liabilityValue.toString(),
                collateralValue: asset.status.collateralValue.toString(),
            },
            underlying: asset.underlying.toLowerCase(),
        });
    };

    let healthScore = totalAssets.mul(et.c1e18).div(totalLiabilities);
    
    return {
        account,
        healthScore,
        markets,
    }
}

function deferAccount(account, time) {
    deferredAccounts[account] = { until: Date.now() + time };
}

module.exports = {
    main,
    processAccounts,
    config,
    setData,
}