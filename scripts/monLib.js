const WebSocket = require('ws');
const {enablePatches, applyPatches} = require('immer');
const ethers = require('ethers');
const { Euler } = require('@eulerxyz/euler-sdk');

const strategies = require('./strategies');
const EulerToolClient = require('./EulerToolClient.js');
const { cartesian, c1e18, txOpts } = require('./utils');
const Reporter = require('./reporter');

const NETWORK = process.env.NETWORK || 'mainnet';
const botConfig = require('../bot.config')[NETWORK];

enablePatches();

let subsData = {};
let showLogs;
let euler;
let reporter = { log: () => {} };

let deferredAccounts = {};
let bestStrategy;

async function main() {
    const provider = new ethers.providers.JsonRpcProvider(botConfig.jsonRpcUrl)
    const wallet = new ethers.Wallet(process.env.PRV_KEY, provider)

    config(new Euler(wallet, botConfig.chainId));

    reporter = new Reporter(botConfig.reporter);

    let designatedAccount = process.env.LIQUIDATE_ACCOUNT
    if (designatedAccount) {
        console.log(`ATTEMPTING LIQUIDATION OF DESIGNATED ACCOUNT ${designatedAccount}`)
        await liquidateDesignatedAccount(designatedAccount);
        process.exit(0);
    }
    doConnect();
}

async function config(eul, logs = true) {
    showLogs = logs;
    euler = eul;
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
                   endpoint: botConfig.eulerscan.ws,
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
            healthMax: botConfig.eulerscan.healthMax || 1000000,
            limit: botConfig.eulerscan.queryLimit || 500
        },
    }, (err, patch) => {
        // console.log('patch: ', JSON.stringify(patch, null, 2));
        if (err) {
            console.log(`ERROR from client: ${err}`);
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
                if (deferredAccounts[act.account] && deferredAccounts[act.account].until > Date.now()) {
                    // console.log(`Skipping deferred ${act.account}`);
                    continue;
                }

                await doLiquidation(act);
                break;
            }
        }
    } catch (e) {
        console.log('e: ', e);
        reporter.log({ type: reporter.ERROR, account: processedAccount, error: e, strategy: bestStrategy && bestStrategy.describe() })
        deferAccount(processedAccount.account, 5 * 60000);
    } finally {
        inFlight = false;
        bestStrategy = null;
    }
}

async function liquidateDesignatedAccount(violator) {
    let account = await getAccountLiquidity(violator);

    console.log(`Account ${violator} health = ${ethers.utils.formatEther(account.healthScore)}`);
    if (account.healthScore.gte(c1e18)) {
        console.log(`  Account not in violation.`);
        return;
    }

    await doLiquidation(account);
}

async function doLiquidation(act) {
    let isProfitable = (opportunity, feeData) => {
        if (Number(botConfig.minYield) === 0) return true;

        let gasCost = feeData.maxFeePerGas.mul(opportunity.gas);
        return opportunity.yield.sub(gasCost).gte(ethers.utils.parseEther(botConfig.minYield));
    }

    let { totalLiabilities, totalCollateral, maxCollateralValue } = await getAccountLiquidity(act.account);

    act = {
        ...act,
        totalLiabilities,
        totalCollateral,
    }

    if (
        botConfig.skipInsufficientCollateral &&
        maxCollateralValue.lt(ethers.utils.parseEther(botConfig.minYield))
    ) {
        reporter.log({ type: reporter.SKIP_INSUFFICIENT_COLLATERAL, account: act, maxCollateralValue })
        deferAccount(act.account, 20 * 60000);
        return;
    }

    let activeStrategies = [strategies.EOASwapAndRepay]; // TODO config
    let collaterals = act.markets.filter(m => m.liquidityStatus.collateralValue !== '0');
    let underlyings = act.markets.filter(m => m.liquidityStatus.liabilityValue !== '0');


    // TODO all settled?
    let opportunities = await Promise.all(
        cartesian(collaterals, underlyings, activeStrategies).map(
            async ([collateral, underlying, Strategy]) => {
                const strategy = new Strategy(act, collateral, underlying, euler, reporter);
                await strategy.findBest();
                return strategy;
            }
        )
    );

    bestStrategy = opportunities.reduce((accu, o) => {
        return o.best && o.best.yield.gt(accu.best.yield) ? o : accu;
    }, { best: { yield: 0 }});

    if (bestStrategy.best.yield === 0) {
        deferAccount(act.account, 5 * 60000)
        reporter.log({ type: reporter.NO_OPPORTUNITY_FOUND, account: act })
        return false;
    }
    let { opts, feeData } = await txOpts(euler.getProvider());
    // use unmodified fee estimate for profitability calculation
    if (!isProfitable(bestStrategy.best, feeData)) {
        deferAccount(act.account, 10 * 60000)
        reporter.log({ type: reporter.YIELD_TOO_LOW, account: act, yield: bestStrategy.best.yield, gas: bestStrategy.best.gas.mul(feeData.maxFeePerGas), required: botConfig.minYield });
        return false;
    }
    let tx = await bestStrategy.exec(opts, isProfitable);

    let botEthBalance = await euler.getSigner().getBalance();

    reporter.log({ type: reporter.LIQUIDATION, account: act, tx, strategy: bestStrategy.describe(), balanceLeft: botEthBalance });
    return true;
}

async function getAccountLiquidity(account) {
    let detLiq = await euler.contracts.exec.callStatic.detailedLiquidity(account);

    let markets = [];

    let totalLiabilities = ethers.BigNumber.from(0);
    let totalAssets = ethers.BigNumber.from(0);
    let maxCollateralValue = ethers.BigNumber.from(0);

    for (let asset of detLiq) {
        totalLiabilities = totalLiabilities.add(asset.status.liabilityValue);
        totalAssets = totalAssets.add(asset.status.collateralValue);
        if (maxCollateralValue.lt(asset.status.collateralValue)) maxCollateralValue = ethers.BigNumber.from(asset.status.collateralValue);

        markets.push({ 
            liquidityStatus: {
                liabilityValue: asset.status.liabilityValue.toString(),
                collateralValue: asset.status.collateralValue.toString(),
            },
            underlying: asset.underlying.toLowerCase(),
        });
    };

    let healthScore = totalAssets.mul(c1e18).div(totalLiabilities);

    return {
        totalLiabilities,
        totalCollateral: totalAssets,
        maxCollateralValue,
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