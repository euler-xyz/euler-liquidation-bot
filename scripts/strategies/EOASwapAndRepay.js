let { cartesian, filterOutRejected } = require("../utils");
const et = require('euler-contracts/test/lib/eTestLib.js');

class EOASwapAndRepay {
    constructor(act, collateral, underlying, ctx) {
        this.ctx = ctx;
        this.violator = act.account;
        this.liquidator = ctx.wallet.address;
        this.collateralAddr = collateral.underlying.toLowerCase();
        this.underlyingAddr = underlying.underlying.toLowerCase();
        this.refAsset = 
            (
                ctx.tokenSetup.riskManagerSettings &&
                ctx.tokenSetup.riskManagerSettings.referenceAsset &&
                ctx.tokenSetup.riskManagerSettings.referenceAsset.toLowerCase()
            )
            || ctx.contracts.tokens.WETH.address; // during tests
        this.best = null;
        this.name = 'EOASwapAndRepay';
    }

    async findBest() {
        let paths;
        let feeLevels = [500, 3000, 10000];

        let eTokenAddress = await this.ctx.contracts.markets.underlyingToEToken(this.collateralAddr);
        this.collateralEToken = await ethers.getContractAt('EToken', eTokenAddress);
        this.collateralToken = await et.taskUtils.lookupToken(this.ctx, this.collateralAddr);

        let liqOpp = await this.ctx.contracts.liquidation.callStatic.checkLiquidation(
            this.liquidator,
            this.violator,
            this.underlyingAddr,
            this.collateralAddr,
        );

        if (liqOpp.repay.eq(0)) return;

        if ([this.collateralAddr, this.underlyingAddr].includes(this.refAsset)) {
            paths = feeLevels.map(fee => {
                return this.encodePath([this.underlyingAddr, this.collateralAddr], [fee]);
            });
        } else {
            // TODO explosion! try auto router, sdk
            paths = cartesian(feeLevels, feeLevels).map(([feeIn, feeOut]) => {
                return this.encodePath([this.underlyingAddr, this.refAsset, this.collateralAddr], [feeIn, feeOut]);
            });
        }

        let repayFraction = 98;
        while (!this.best && repayFraction > 0) {
            let repay = liqOpp.repay.mul(repayFraction).div(100);

            let tests = await Promise.allSettled(
                paths.map(async (swapPath) => {
                    return {
                        swapPath,
                        repay,
                        yield: await this.testLiquidation(swapPath, repay)
                    };
                })
            );

            // TODO retry failed or continue
            tests = filterOutRejected(tests, (i, err) => {
                // console.log(`EOASwapAndRepay failed test ${this.violator}, c: ${this.collateralAddr} u: ${this.underlyingAddr} path: ${paths[i]} error: ${err}`)
            })

            let best = tests.reduce((accu, t) => {
                return t.yield.gt(accu.yield) ? t : accu;
            }, { swapPath: null, yield: ethers.BigNumber.from(0) });


            this.best = best.yield.gt(0) ? best : null;

            repayFraction = Math.floor(repayFraction / 2);
        }
    }

    async exec() {
        if (!this.best) throw 'No opportunity found yet!';

        await et.taskUtils.runTx(
            this.ctx.contracts.exec.batchDispatch(
                this.ctx.buildBatch(this.buildLiqBatch(this.best.swapPath, this.best.repay)),
                [this.liquidator],
                ({...await this.ctx.txOpts(), gasLimit: 1200000})
            ),
        );
    }

    logBest() {
        if (!this.best) {
            console.log('EOASwapAndRepay: No opportunity found')
        } else {
            console.log(
                `EOASwapAndRepay c: ${this.collateralAddr} u: ${this.underlyingAddr} repay: ${this.best.repay.toString()} `
                 +`yield: ${this.best.yield.toString()} path ${this.best.swapPath}`
            );
        }
    }

    // PRIVATE

    buildLiqBatch(swapPath, repay) {
        let conversionItem;

        if (this.underlyingAddr === this.collateralAddr) {
            conversionItem = {
                contract: this.collateralEToken,
                method: 'burn',
                args: [
                    0,
                    ethers.constants.MaxUint256,
                ],
            };
        } else {
            conversionItem = {
                contract: 'swap',
                method: 'swapAndRepayUni',
                args: [
                    {
                        subAccountIdIn: 0,
                        subAccountIdOut: 0,
                        amountOut: 0,
                        amountInMaximum: ethers.constants.MaxUint256,
                        deadline: 0, // FIXME!
                        path: swapPath,
                    },
                    0,
                ],
            };
        }
        return [
            {
                contract: 'liquidation',
                method: 'liquidate',
                args: [
                    this.violator,
                    this.underlyingAddr,
                    this.collateralAddr,
                    repay,
                    0,
                ],
            },
            conversionItem,
            {
                contract: 'markets',
                method: 'exitMarket',
                args: [
                    0,
                    this.underlyingAddr,
                ],
            },
        ];
    }

    async testLiquidation(swapPath, repay) {
        let batchItems = [
            {
                contract: this.collateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ]
            },
            ...this.buildLiqBatch(swapPath, repay),
            {
                contract: 'exec',
                method: 'getPriceFull',
                args: [
                    this.collateralAddr,
                ],
            },
            {
                contract: this.collateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ],
            },
        ];

        let res = await this.ctx.contracts.exec.callStatic.batchDispatch(this.ctx.buildBatch(batchItems), [this.liquidator]);

        let decoded = await this.ctx.decodeBatch(batchItems, res);

        let balanceBefore = decoded[0][0];
        let balanceAfter = decoded[decoded.length - 1][0];

        if (balanceAfter.lte(balanceBefore)) throw `No yield ${repay} ${swapPath}`;

        let yieldCollateral = balanceAfter.sub(balanceBefore);
        
        let collateralDecimals = await this.collateralToken.decimals();

        let yieldEth = yieldCollateral
            .mul(ethers.BigNumber.from(10).pow(18 - collateralDecimals))
            .mul(decoded[decoded.length - 2].currPrice).div(et.c1e18);

        return yieldEth;
    }

    encodePath(path, fees) {
        let FEE_SIZE = 3;
    
        if (path.length != fees.length + 1) {
            throw new Error('path/fee lengths do not match');
        }
    
        let encoded = '0x';
        for (let i = 0; i < fees.length; i++) {
            // 20 byte encoding of the address
            encoded += path[i].slice(2);
            // 3 byte encoding of the fee
            encoded += fees[i].toString(16).padStart(2 * FEE_SIZE, '0');
        }
        // encode the final token
        encoded += path[path.length - 1].slice(2);
    
        return encoded.toLowerCase();
    }
}

module.exports = EOASwapAndRepay;
