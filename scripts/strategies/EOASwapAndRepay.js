let ethers = require("ethers");
let { cartesian, filterOutRejected, c1e18, txOpts } = require("../utils");

const MAX_UINT = ethers.constants.MaxUint256;

class EOASwapAndRepay {
    constructor(act, collateral, underlying, euler) {
        this.euler = euler;
        this.violator = act.account;
        this.liquidator = euler.getSigner().address;
        this.collateralAddr = collateral.underlying.toLowerCase();
        this.underlyingAddr = underlying.underlying.toLowerCase();
        this.refAsset = euler.referenceAsset
        this.best = null;
        this.name = 'EOASwapAndRepay';
        this.isProtectedCollateral = false;
    }

    async findBest() {
        let paths;
        let feeLevels = [100, 500, 3000, 10000];


        let protectedUnderlying
        try {
            protectedUnderlying = await this.euler.pToken(this.collateralAddr).underlying();
        } catch {}

        if (protectedUnderlying) {
            const u2p  = await this.euler.contracts.markets.underlyingToPToken(protectedUnderlying)
            if (this.collateralAddr.toLowerCase() === u2p.toLowerCase()) {
                this.isProtectedCollateral = true;
                this.unwrappedCollateralAddr = protectedUnderlying;
                const unwrappedEToken = await this.euler.contracts.markets.underlyingToEToken(protectedUnderlying)
                this.unwrappedCollateralEToken = this.euler.eToken(unwrappedEToken)
            }
        }

        let eTokenAddress = await this.euler.contracts.markets.underlyingToEToken(this.collateralAddr);
        this.collateralEToken = this.euler.eToken(eTokenAddress);
        this.collateralToken = this.euler.erc20(this.collateralAddr);

        let liqOpp = await this.euler.contracts.liquidation.callStatic.checkLiquidation(
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
            // TODO don't do combination if collateral is the same as underlying - burn conversion item
            const collateral = this.isProtectedCollateral ? this.unwrappedCollateralAddr : this.collateralAddr;
            paths = cartesian(feeLevels, feeLevels).map(([feeIn, feeOut]) => {
                return this.encodePath([this.underlyingAddr, this.refAsset, collateral], [feeIn, feeOut]);
            });
        }

        let repayFraction = 98;
        while (!this.best && repayFraction > 0) {
            let repay = liqOpp.repay.mul(repayFraction).div(100);

            let tests = await Promise.allSettled(
                paths.map(async (swapPath) => {
                    let { yieldEth, unwrapAmmount } = await this.testLiquidation(swapPath, repay)
                    return {
                        swapPath,
                        repay,
                        yield: yieldEth,
                        unwrapAmmount,
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

        return await (
            await this.euler.contracts.exec.batchDispatch(
                this.euler.buildBatch(this.buildLiqBatch(this.best.swapPath, this.best.repay, this.best.unwrapAmmount)),
                [this.liquidator],
                ({...await txOpts(this.euler.getProvider()), gasLimit: 1200000})
            )
        ).wait();
    }

    describe() {
        return this.best
            ? `EOASwapAndRepay c: ${this.collateralAddr}, u: ${this.underlyingAddr}, repay: ${this.best.repay.toString()} `
                +`yield: ${ethers.utils.formatEther(this.best.yield)} ETH, path ${this.best.swapPath}`
            : 'EOASwapAndRepay: No opportunity found';
    }

    // PRIVATE

    buildLiqBatch(swapPath, repay, unwrapAmmount) {
        let conversionItems = [];

        if (this.underlyingAddr === this.collateralAddr) {
            conversionItems.push(
                {
                    contract: this.collateralEToken,
                    method: 'burn',
                    args: [
                        0,
                        MAX_UINT,
                    ],
                }
            );
        } else {
            if (this.isProtectedCollateral) {
                conversionItems.push(
                    {
                        contract: this.collateralEToken,
                        method: 'withdraw',
                        args: [0, MAX_UINT],
                    },
                    {
                        contract: 'exec',
                        method: 'pTokenUnWrap',
                        args: [
                            this.unwrappedCollateralAddr,
                            unwrapAmmount
                        ]
                    },
                    {
                        contract: this.unwrappedCollateralEToken,
                        method: 'deposit',
                        args: [0, MAX_UINT]
                    },
                )
            }
            conversionItems.push(
                {
                    contract: this.collateralEToken,
                    method: 'balanceOfUnderlying',
                    args: [
                        this.liquidator,
                    ]
                },
                {
                    contract: 'swap',
                    method: 'swapAndRepayUni',
                    args: [
                        {
                            subAccountIdIn: 0,
                            subAccountIdOut: 0,
                            amountOut: 0,
                            amountInMaximum: MAX_UINT,
                            deadline: 0, // FIXME!
                            path: swapPath,
                        },
                        0,
                    ],
                }
            );
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
            ...conversionItems,
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
        let unwrapAmmount
        if (this.isProtectedCollateral) {
            unwrapAmmount = await this.getYieldByRepay(repay);
            await (await this.euler.erc20(this.unwrappedCollateralAddr).approve(this.euler.addresses.euler, MAX_UINT)).wait();
        }

        const targetCollateralEToken = this.isProtectedCollateral ? this.unwrappedCollateralEToken : this.collateralEToken;

        let batchItems = [
            {
                contract: targetCollateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ]
            },
            ...this.buildLiqBatch(swapPath, repay, unwrapAmmount),
            {
                contract: 'exec',
                method: 'getPriceFull',
                args: [
                    this.collateralAddr,
                ],
            },
            {
                contract: targetCollateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ],
            },
        ];


        let res = await this.euler.contracts.exec.callStatic.batchDispatch(this.euler.buildBatch(batchItems), [this.liquidator]);

        let decoded = await this.euler.decodeBatch(batchItems, res);

        let balanceBefore = decoded[0][0];
        let balanceAfter = decoded[decoded.length - 1][0];

        if (balanceAfter.lte(balanceBefore)) throw `No yield ${repay} ${swapPath}`;

        let yieldCollateral = balanceAfter.sub(balanceBefore);

        let collateralDecimals = await this.collateralToken.decimals();

        let yieldEth = yieldCollateral
            .mul(ethers.BigNumber.from(10).pow(18 - collateralDecimals))
            .mul(decoded[decoded.length - 2].currPrice).div(c1e18);

        return {
            yieldEth,
            unwrapAmmount,
        };
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

    async getYieldByRepay(repay) {
        const batch = [
            {
                contract: this.collateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ]
            },
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
            {
                contract: this.collateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.liquidator,
                ]
            },
        ];

        let res = await this.euler.contracts.exec.callStatic.batchDispatch(this.euler.buildBatch(batch), [this.liquidator]);

        let decoded = await this.euler.decodeBatch(batch, res);

        let balanceBefore = decoded[0][0];
        let balanceAfter = decoded[decoded.length - 1][0];

        return balanceAfter.sub(balanceBefore);
    }
}

module.exports = EOASwapAndRepay;
