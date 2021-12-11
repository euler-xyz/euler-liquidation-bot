const { cartesian, filtreOutRejected } = require("../utils");

class BotSwapAndRepay {
    constructor(act, collateral, underlying, eulerAddresses, liquidationBotContract) {
        this.eulerAddresses = eulerAddresses;
        this.bot = liquidationBotContract;
        this.act = act;
        this.collateral = collateral;
        this.underlying = underlying;
        this.best = { yield: 0};
        this.name = 'BotSwapAndRepay'
    }

    async findBest() {
        const feeLevels = [500, 3000, 10000];
        let paths;

        if (this.collateral.underlying.toLowerCase() === this.eulerAddresses.tokens.WETH.toLowerCase()) {
            paths = feeLevels.map(fee => {
                return this.encodePath([collateral.underlying, underlying.underlying], [fee]);
            });
        } else {
            // TODO explosion! try auto router, sdk
            paths = cartesian(feeLevels, feeLevels).map(([feeIn, feeOut]) => {
                return this.encodePath([this.underlying.underlying, this.eulerAddresses.tokens.WETH, this.collateral.underlying], [feeIn, feeOut]);
            });
        }
        // console.log('paths: ', paths);

        let tests = await Promise.allSettled(
            paths.map(async (swapPath) => {
                return {
                    swapPath,
                    yield: await this.testUniswapLiquidation(swapPath)
                };
            })
        );

        // TODO retry failed or continue
        // console.log('tests: ', tests);
        
        tests = filtreOutRejected(tests, (i, err) => {
            // console.log(`Failed uniswap test ${this.act}, ${this.collateral.symbol} / ${this.underlying.symbol}: ${paths[i]} ${err}`)
        })


        const best = tests.reduce((accu, t) => {
            return t.yield.gt(accu.yield) ? t : accu;
        }, { swapPath: null, yield: 0 });


        this.best = best.yield.gt(0) ? best : null;
    }

    async exec() {
        if (!this.best) throw 'No opportunity found yet!';
        
        let tx = await this.bot.liquidate(
            this.uniswapLiquidationParams(this.best.swapPath)
        );

        let res = await tx.wait();
        return res;
    }

    logBest() {
        if (!this.best) {
            console.log('No opportunity found')
        } else {
            console.log(`BotSwapAndRepay c: ${this.collateral.symbol} u: ${this.underlying.symbol} yield: ${this.best.yield.toString()} path ${this.best.swapPath}`);
        }
    }

    // PRIVATE

    uniswapLiquidationParams(swapPath) {
        return {
            eulerAddr: this.eulerAddresses.euler,
            liquidationAddr: this.eulerAddresses.liquidation,
            execAddr: this.eulerAddresses.exec,
            marketsAddr: this.eulerAddresses.markets,
            swapAddr: this.eulerAddresses.swap,

            swapPath,

            violator: this.act.account,
            underlying: this.underlying.underlying,
            collateral: this.collateral.underlying,
        }
    }



    async testUniswapLiquidation(swapPath) {
        let res = await this.bot.callStatic.testLiquidation(
            this.uniswapLiquidationParams(swapPath)
        );
        // console.log(`Uniswap test yield: ${res.toString()} ${this.act.account}, c: ${this.collateral.symbol}, u: ${this.underlying.symbol}, ${swapPath}'`);
        return res;
    }

    encodePath(path, fees) {
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
}

module.exports = BotSwapAndRepay;

