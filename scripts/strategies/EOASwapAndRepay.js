const { cartesian, filtreOutRejected } = require("../utils");

class EOASwapAndRepay {
    constructor(act, collateral, underlying, eulerAddresses, liquidationBotContract) {
        this.eulerAddresses = eulerAddresses;
        this.bot = liquidationBotContract;
        this.act = act;
        this.collateral = collateral;
        this.underlying = underlying;
        this.best = { yield: 0};
        this.name = 'EOASwapAndRepay';

    }

    async findBest() {
        let paths;
        const feeLevels = [500, 3000, 10000];

        // TODO create context with all instances
        this.execContract = await ethers.getContractAt('Exec', this.eulerAddresses.exec);
        this.swapContract = await ethers.getContractAt('Swap', this.eulerAddresses.swap);
        this.liquidationContract = await ethers.getContractAt('Liquidation', this.eulerAddresses.liquidation);
        this.marketsContract = await ethers.getContractAt('Markets', this.eulerAddresses.markets);

        const eTokenAddress = await this.marketsContract.underlyingToEToken(this.collateral.underlying);
        this.collateralETokenContract = await ethers.getContractAt('EToken', eTokenAddress);

        const wallets = await ethers.getSigners();
        this.liquidator = wallets[0].address;

        const liqOpp = await this.liquidationContract.callStatic.checkLiquidation(
            this.liquidator,
            this.act.account,
            this.underlying.underlying,
            this.collateral.underlying,
        );

        if (liqOpp.repay.eq(0)) return;
        this.repay = liqOpp.repay.mul(9).div(10);



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


        let tests = await Promise.allSettled(
            paths.map(async (swapPath) => {
                return {
                    swapPath,
                    yield: await this.testLiquidation(swapPath)
                };
            })
        );

        // TODO retry failed or continue
        // console.log('tests: ', tests);
        
        tests = filtreOutRejected(tests, (i, err) => {
            // throw err;
            // console.log(`EOASwapAndRepay failed test ${this.act}, c: ${this.collateral.symbol} u: ${this.underlying.symbol} path: ${paths[i]} error: ${err}`)
        })


        const best = tests.reduce((accu, t) => {
            return t.yield.gt(accu.yield) ? t : accu;
        }, { swapPath: null, yield: ethers.BigNumber.from(0) });


        this.best = best.yield.gt(0) ? best : null;
    }

    async exec() {
        if (!this.best) throw 'No opportunity found yet!';
        
        let tx = await this.execContract.batchDispatch(
            this.createBatch(this.best.swapPath),
            [this.liquidator],
        );

        let res = await tx.wait();
        return res;
    }

    logBest() {
        if (!this.best) {
            console.log('EOASwapAndRepay: No opportunity found')
        } else {
            console.log(`EOASwapAndRepay c: ${this.collateral.symbol} u: ${this.underlying.symbol} yield: ${this.best.yield.toString()} path ${this.best.swapPath}`);
        }
    }

    // PRIVATE

    createBatch(swapPath) {
        return [
            {
                allowError: false,
                proxyAddr: this.liquidationContract.address,
                data: this.liquidationContract.interface.encodeFunctionData("liquidate", [
                    this.act.account,
                    this.underlying.underlying,
                    this.collateral.underlying,
                    this.repay,
                    0
                ])
            },
            {
                allowError: false,
                proxyAddr: this.swapContract.address,
                data: this.swapContract.interface.encodeFunctionData("swapAndRepayUni", [
                    {
                        subAccountIdIn: 0,
                        subAccountIdOut: 0,
                        amountOut: 0,
                        amountInMaximum: ethers.constants.MaxUint256,
                        deadline: 0, // FIXME!
                        path: swapPath,
                    },
                    0
                ]),
            },
            {
                allowError: false,
                proxyAddr: this.marketsContract.address,
                data: this.marketsContract.interface.encodeFunctionData("exitMarket", [
                    0,
                    this.underlying.underlying,
                ]),
            },
        ];
    }



    async testLiquidation(swapPath) {
        const batch = [
            {
                allowError: false,
                proxyAddr: this.collateralETokenContract.address,
                data: this.collateralETokenContract.interface.encodeFunctionData("balanceOf", [this.liquidator]),
            },
            ...this.createBatch(swapPath),
            {
                allowError: false,
                proxyAddr: this.collateralETokenContract.address,
                data: this.collateralETokenContract.interface.encodeFunctionData("balanceOf", [this.liquidator]),
            },
        ]

        let res = await this.execContract.callStatic.batchDispatch(batch, [this.liquidator]);

        res.forEach(r => {
            if (!r.success) throw `Test call failed! path: ${swapPath}, e: ${r.result}`;
        })
        const balanceBefore = this.collateralETokenContract.interface.decodeFunctionResult('balanceOf', res[0].result)[0];
        const balanceAfter = this.collateralETokenContract.interface.decodeFunctionResult('balanceOf', res[4].result)[0];

        const finalYield = balanceAfter.sub(balanceBefore);

        if (finalYield.lt(0)) throw `Negative yeald! ${swapPath}`
        return finalYield;
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

module.exports = EOASwapAndRepay;

