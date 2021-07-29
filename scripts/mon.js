const WebSocket = require('ws');
const {enablePatches, applyPatches} = require('immer');
const fs = require("fs");

const EulerToolClient = require('./EulerToolClient.js');

enablePatches();


let liquidationBotContract;
let subsData = {};
let eulerAddresses = JSON.parse(fs.readFileSync('../euler-contracts/euler-addresses.json'));
console.log(eulerAddresses);



async function main() {
    let factory = await ethers.getContractFactory('LiquidationBot');
    liquidationBotContract = await (await factory.deploy()).deployed();
    console.log("liq bot contract deployed:", liquidationBotContract.address);

    doConnect();
}

main();





function doConnect() {
    let ec; ec = new EulerToolClient({
                   version: 'liqmon 1.0',
                   endpoint: 'ws://localhost:8900',
                   WebSocket,
                   onConnect: () => {
                       console.log("CONNECTED");
                   },
                   onDisconnect: () => {
                       console.log("ORDERBOOK DISCONNECT");
                       subsData = {};
                   },
                });

    ec.sub({ query: { topic: "accounts", by: "healthScore", } }, (err, patch) => {
        if (err) {
            console.log(`ERROR from client: ${err}`);
            return;
        }

        for (let p of patch.result) p.path = p.path.split('/').filter(e => e !== '');
        subsData.accounts = applyPatches(subsData.accounts, patch.result);
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
                console.log("VIOLATION DETECTED",act.account,act.healthScore);
                await doLiquidation(act);
                break;
            }
        }
    } finally {
        inFlight = false;
    }
}

async function doLiquidation(act) {
    let underlying;
    let collateral;

    for (let market of act.markets) {
        if (market.liquidityStatus.liabilityValue !== '0') {
            underlying = market;
            break;
        }
    }

    for (let market of act.markets) {
        if (market.liquidityStatus.collateralValue !== '0') {
            collateral = market;
            break;
        }
    }

    let swapPath;

    if (collateral.underlying.toLowerCase() === eulerAddresses.tokens.WETH.toLowerCase()) {
        swapPath = encodePath([collateral.underlying, underlying.underlying], [3000]);
    } else {
        swapPath = encodePath([collateral.underlying, eulerAddresses.tokens.WETH, underlying.underlying], [3000, 3000]);
        //let swapPath = encodePath([underlying.underlying, eulerAddresses.tokens.WETH, collateral.underlying], [3000, 3000]);
    }

    console.log(`DOING LIQUIDATION: repay ${underlying.symbol} for collateral ${collateral.symbol}`);

    let tx = await liquidationBotContract.liquidate({
                        eulerAddr: eulerAddresses.euler,
                        liquidationAddr: eulerAddresses.liquidation,
                        execAddr: eulerAddresses.exec,
                        marketsAddr: eulerAddresses.markets,

                        swapRouter: eulerAddresses.swapRouter,
                        swapPath,

                        violator: act.account,
                        underlying: underlying.underlying,
                        collateral: collateral.underlying,
                    });

    let res = await tx.wait();
    console.log(res);
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
