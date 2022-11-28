let ethers = require('ethers');
let axios = require('axios');
let { FlashbotsBundleProvider, FlashbotsTransactionResolution } = require('@flashbots/ethers-provider-bundle');
let { cartesian, filterOutRejected, c1e18, txOpts } = require('../utils');
let { utils } = require('@eulerxyz/euler-sdk');

let FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY;
let ONEINCH_API_URL             = process.env.ONEINCH_API_URL;
let useFlashbots                = process.env.USE_FLASHBOTS === 'true';
let flashbotsMaxBlocks          = Number(process.env.FLASHBOTS_MAX_BLOCKS);
let flashbotsDisableFallback    = process.env.FLASHBOTS_DISABLE_FALLBACK === 'true';

let receiverSubAccountId        = Number(process.env.RECEIVER_SUBACCOUNT_ID);

let MAX_UINT    = ethers.constants.MaxUint256;
let formatUnits = ethers.utils.formatUnits;
let parseUnits  = ethers.utils.parseUnits;

let SWAPHUB_MODE_EXACT_OUTPUT = 1;

class EOASwapAndRepay {
    constructor(act, collateral, underlying, euler, reporter) {
        this.act = act;
        this.euler = euler;
        this.violator = act.account;
        this.liquidator = euler.getSigner().address;
        this.receiver = receiverSubAccountId ? utils.getSubAccount(this.liquidator, receiverSubAccountId) : this.liquidator
        this.collateralAddr = collateral.underlying.toLowerCase();
        this.underlyingAddr = underlying.underlying.toLowerCase();
        this.refAsset = euler.referenceAsset.toLowerCase();
        this.best = null;
        this.name = 'EOASwapAndRepay';
        this.isProtectedCollateral = false;
        this.reporter = reporter || console;
    }

    async findBest() {
        let paths;
        let feeLevels = [100, 500, 3000, 10000];

        let protectedUnderlying
        try {
            protectedUnderlying = await this.euler.pToken(this.collateralAddr).underlying();
        } catch {}

        if (protectedUnderlying) {
            let u2p  = await this.euler.contracts.markets.underlyingToPToken(protectedUnderlying);
            if (this.collateralAddr.toLowerCase() === u2p.toLowerCase()) {
                this.isProtectedCollateral = true;
                this.unwrappedCollateralAddr = protectedUnderlying.toLowerCase();
                let unwrappedEToken = await this.euler.contracts.markets.underlyingToEToken(protectedUnderlying);
                this.unwrappedCollateralEToken = this.euler.eToken(unwrappedEToken);

                let allowance = await this.euler.erc20(this.unwrappedCollateralAddr).allowance(this.liquidator, this.euler.addresses.euler);
                let { opts } = await txOpts(this.euler.getProvider())
                if (allowance.eq(0)) {
                    await (await this.euler.erc20(this.unwrappedCollateralAddr).approve(
                        this.euler.addresses.euler,
                        MAX_UINT,
                        ({...opts, gasLimit: 300000})
                    )).wait();
                }
            }
        }

        this.finalCollateralAddr = this.isProtectedCollateral ? this.unwrappedCollateralAddr : this.collateralAddr;

        this.collateralEToken = await this.euler.eTokenOf(this.collateralAddr);
        this.collateralToken = this.euler.erc20(this.collateralAddr);
        this.collateralDecimals = await this.euler.erc20(this.finalCollateralAddr).decimals();
        this.underlyingEToken = await this.euler.eTokenOf(this.underlyingAddr);
        this.underlyingDecimals = await this.euler.erc20(this.underlyingAddr).decimals();

        let liqOpp = await this.euler.contracts.liquidation.callStatic.checkLiquidation(
            this.liquidator,
            this.violator,
            this.underlyingAddr,
            this.collateralAddr,
        );

        if (liqOpp.repay.eq(0)) return;

        if ([this.finalCollateralAddr, this.underlyingAddr].includes(this.refAsset)) {
            paths = feeLevels.map(fee => {
                return this.encodePath([this.underlyingAddr, this.finalCollateralAddr], [fee]);
            });
        } else {
            // TODO explosion! try auto router, sdk
            // TODO don't do combination if collateral is the same as underlying - burn conversion item
            paths = cartesian(feeLevels, feeLevels).map(([feeIn, feeOut]) => {
                return this.encodePath([this.underlyingAddr, this.refAsset, this.finalCollateralAddr], [feeIn, feeOut]);
            });
        }

        let repayFraction = 98;
        while (!this.best && repayFraction >= 49) {
            let repay = liqOpp.repay.mul(repayFraction).div(100);
            let unwrapAmount;
            if (this.isProtectedCollateral) {
                unwrapAmount = await this.getYieldByRepay(repay);
            }

            let oneInchQuote
            if (this.underlyingAddr !== this.finalCollateralAddr) {
                try {
                    oneInchQuote = await this.getOneInchQuote(repay.div(ethers.BigNumber.from(10).pow(18 - this.underlyingDecimals)));
                } catch (e) {
                    console.log('e: ', e);
                    this.reporter.log({
                        type: this.reporter.ERROR,
                        account: this.act,
                        error: `Failed fetching 1inch quote`,
                        strategy: this.describe(),
                    });
                }
            }

            let tests = await Promise.allSettled(
                paths.map(async (path) => {
                    let { yieldEth, gas } = await this.testLiquidation(path, repay, unwrapAmount, oneInchQuote)
                    return {
                        swapPath: path,
                        repay,
                        yield: yieldEth,
                        unwrapAmount,
                        oneInchQuote,
                        gas,
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

    async exec(opts, isProfitable) {
        if (!this.best) throw 'No opportunity found yet!';

        let execRegularTx = async (opts) => {
            let batch = this.buildLiqBatch(this.best.swapPath, this.best.repay, this.best.unwrapAmount, this.best.oneInchQuote);

            return await (
                await this.euler.contracts.exec.batchDispatch(
                    this.euler.buildBatch(batch),
                    [this.liquidator],
                    opts
                )
            ).wait();
        }

        if (useFlashbots) {
            try {
                let provider = this.euler.getProvider();
                let signer = this.euler.getSigner();
                let flashbotsRelaySigningWallet = FLASHBOTS_RELAY_SIGNING_KEY
                    ? new ethers.Wallet(FLASHBOTS_RELAY_SIGNING_KEY)
                    : ethers.Wallet.createRandom();

                let flashbotsProvider = await FlashbotsBundleProvider.create(
                    provider,
                    flashbotsRelaySigningWallet,
                    ...(this.euler.chainId === 5 ? ['https://relay-goerli.flashbots.net/', 'goerli'] : []),
                );

                let tx = await this.euler.contracts.exec.populateTransaction.batchDispatch(
                    this.euler.buildBatch(this.buildLiqBatch(this.best.swapPath, this.best.repay, this.best.unwrapAmount, this.best.oneInchQuote)),
                    [this.liquidator],
                    opts,
                );

                tx = {
                    ...tx,
                    type: 2,
                    chainId: this.euler.chainId,
                    nonce: await provider.getTransactionCount(signer.address),
                };

                let blockNumber = await this.euler.getProvider().getBlockNumber();

                let signedTransaction = await signer.signTransaction(tx);
                let simulation = await flashbotsProvider.simulate(
                    [signedTransaction],
                    blockNumber + 1,
                );

                if (simulation.error) {
                    throw new Error(simulation.error.message);
                }
                if (simulation.firstRevert) {
                    throw new Error(`${simulation.firstRevert.error} ${simulation.firstRevert.revert}`);
                }

                let privateTx = {
                    transaction: tx,
                    signer,
                };
                let fbOpts = flashbotsMaxBlocks > 0 
                    ? { maxBlockNumber: blockNumber + flashbotsMaxBlocks }
                    : {};
                let submission = await flashbotsProvider.sendPrivateTransaction(
                    privateTx, 
                    fbOpts
                );

                if (submission.error) {
                    throw new Error(submission.error.message);
                }

                let txResolution = await submission.wait();

                if (txResolution !== FlashbotsTransactionResolution.TransactionIncluded) {
                    throw new Error('Transaction dropped');
                }

                return submission;
            } catch (e) {
                console.log('e: ', e);

                if (!flashbotsDisableFallback) {
                    this.reporter.log({
                        type: this.reporter.ERROR,
                        account: this.act,
                        error: `Flashbots error, falling back to regular tx. err: "${e}"`,
                        strategy: this.describe(),
                    });
                    // recalculate opportunity
                    await this.findBest();
                    let { opts: newOpts, feeData } = await txOpts(this.euler.getProvider());
                    if (!isProfitable(this.best, feeData)) throw new Error('Fallback tx is no longer profitable');

                    return execRegularTx(newOpts);
                } else {
                    throw e;
                }
            }
        }

        return execRegularTx(opts);
    }

    describe() {
        return this.best
            ? `EOASwapAndRepay c: ${this.collateralAddr}, u: ${this.underlyingAddr}, repay: ${this.best.repay.toString()} `
                +`yield: ${ethers.utils.formatEther(this.best.yield)} ETH, path ${this.best.swapPath}`
            : 'EOASwapAndRepay: No opportunity found';
    }

    // PRIVATE

    buildLiqBatch(swapPath, repay, unwrapAmount, oneInchQuote) {
        let conversionItems = [];

        let collateralEToken = this.isProtectedCollateral ? this.unwrappedCollateralEToken : this.collateralEToken;

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
                        unwrapAmount
                    ]
                },
                {
                    contract: this.unwrappedCollateralEToken,
                    method: 'deposit',
                    args: [0, MAX_UINT]
                },
            )
        }

        if (this.underlyingAddr === this.finalCollateralAddr) {
            // TODO test
            conversionItems.push(
                {
                    contract: collateralEToken,
                    method: 'burn',
                    args: [
                        0,
                        MAX_UINT,
                    ],
                }
            );
        } else {
            if (oneInchQuote) {
                conversionItems.push(
                    {
                        contract: 'swapHub',
                        method: 'swapAndRepay',
                        args: [
                            0, // sub-account in
                            0, // sub-account out
                            this.euler.addresses.swapHandler1Inch,
                            {
                                underlyingIn: this.finalCollateralAddr,
                                underlyingOut: this.underlyingAddr,
                                mode: SWAPHUB_MODE_EXACT_OUTPUT,
                                amountIn: MAX_UINT, // MAX SLIPPAGE ALLOWED! Assuming the bot doesn't hold any token balances before the liquidation
                                amountOut: 0, // Ignored by swapAndRepay
                                // Arbitrary 1000 wei to account for fee on transfer or rebasing tokens like stETH.
                                // For tokens with less decimals than 15 decimals it will be ineffective.
                                exactOutTolerance: 1000,
                                payload: ethers.utils.defaultAbiCoder.encode(
                                    ["bytes", "bytes"],
                                    [oneInchQuote.payload, swapPath],
                                ),
                            },
                            0, // target debt
                        ]
                    },
                )
            } else {
                conversionItems.push(
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
                    },
                );
            }
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
            ...(this.liquidator !== this.receiver
                ? [{
                    contract: this.collateralEToken,
                    method: 'transferFromMax',
                    args: [this.liquidator, this.receiver],
                  }]
                : []
            )
        ];
    }

    async testLiquidation(swapPath, repay, unwrapAmount, oneInchQuote) {
        const targetCollateralEToken = this.isProtectedCollateral ? this.unwrappedCollateralEToken : this.collateralEToken;

        let batchItems = [
            {
                contract: targetCollateralEToken,
                method: 'balanceOfUnderlying',
                args: [
                    this.receiver,
                ]
            },
            ...this.buildLiqBatch(swapPath, repay, unwrapAmount, oneInchQuote),
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
                    this.receiver,
                ],
            },
        ];
        let simulation, error, gas;
        ({ simulation, error, gas } = await this.euler.simulateBatch([this.liquidator], batchItems));
        if (error) throw error.value;

        let balanceBefore = simulation[0].response[0];
        let balanceAfter = simulation[simulation.length - 1].response[0];

        if (balanceAfter.lte(balanceBefore)) throw `No yield ${repay} ${swapPath}`;
        let yieldCollateral = balanceAfter.sub(balanceBefore);

        let yieldEth = yieldCollateral
            .mul(ethers.BigNumber.from(10).pow(18 - this.collateralDecimals))
            .mul(simulation[simulation.length - 2].response.currPrice).div(c1e18);

        return { yieldEth, gas };
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
        let batch = [
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

        let { simulation } = await this.euler.simulateBatch([this.liquidator], batch);

        let balanceBefore = simulation[0].response[0];
        let balanceAfter = simulation[simulation.length - 1].response[0];

        return balanceAfter.sub(balanceBefore);
    }

    async getOneInchQuote(targetAmountOut) {
        if (!ONEINCH_API_URL) return;

        let getQuote = async amount => {
            let searchParams = new URLSearchParams({
                fromTokenAddress: this.finalCollateralAddr,
                toTokenAddress: this.underlyingAddr,
                amount: amount.toString(),
                disableEstimate: "true",
                destReceiver: this.euler.addresses.euler,
                fromAddress: this.euler.addresses.swapHandler1Inch,
                allowPartialFill: "false",
                slippage: "50", // max slippage
            })
            let err
            for (let i = 0; i < 3; i++) {
                await new Promise(r => setTimeout(r, i * 100));

                try {
                    let { data } = await axios.get(`${ONEINCH_API_URL}?${searchParams.toString()}`);

                    return data;
                } catch (e) {
                    console.log(e);
                    err = e;
                }
            }

            throw err;
        }

        let findEstimatedAmountIn = async () => {
            let fromDecimals = this.collateralDecimals;
            let toDecimals = this.underlyingDecimals;

            let unitQuote = await getQuote(
                ethers.utils.parseUnits("1", fromDecimals),
            );

            let unitAmountTo = ethers.BigNumber.from(unitQuote.toTokenAmount);

            let fromAmount = targetAmountOut;
            // adjust scale to match token from
            if (fromDecimals > toDecimals) {
                fromAmount = fromAmount.mul(
                    ethers.BigNumber.from("10").pow(fromDecimals - toDecimals),
                );
            } else {
                fromAmount = fromAmount.div(
                    ethers.BigNumber.from("10").pow(toDecimals - fromDecimals),
                );
            }
            // divide by unit price
            return (fromAmount = fromAmount
                .mul(ethers.utils.parseUnits("1", toDecimals))
                .div(unitAmountTo));
        };

        let find1InchRoute = async (
            targetAmountTo,
            amountFrom,
            shouldContinue,
        ) => {
            let result;
            let percentageChange = 10000; // 100% no change
            let cnt = 0;
            do {
                amountFrom = amountFrom.mul(percentageChange).div(10000);
                result = await getQuote(amountFrom);
                let swapAmountTo = ethers.BigNumber.from(result.toTokenAmount);
                percentageChange = swapAmountTo.eq(targetAmountTo)
                    ? 9990 // result equal target, push input down by 0.1%
                    : swapAmountTo.gt(targetAmountTo)
                        ? // result above target, adjust input down by the percentage difference of outputs - 0.1%
                        swapAmountTo
                            .sub(targetAmountTo)
                            .mul(10000)
                            .div(targetAmountTo)
                            .add(10)
                            .sub(10000)
                            .abs()
                        : // result below target, adjust input by the percentege difference of outputs + 0.1%
                        targetAmountTo
                            .sub(swapAmountTo)
                            .mul(10000)
                            .div(swapAmountTo)
                            .add(10000)
                            .add(10);

                    if (cnt++ === 15) throw new Error("Failed fetching quote in 15 iterations");
                } while (shouldContinue(result));

            return { amountFrom, result };
        };

        // rough estimate by calculating execution price on a unit trade 
        let estimatedAmountIn = await findEstimatedAmountIn();

        let { amountFrom, result } = await find1InchRoute(
            targetAmountOut,
            estimatedAmountIn,
            // search until quote is 99.5 - 100% target
            result =>
                targetAmountOut.lte(result.toTokenAmount)
                || (
                    ethers.BigNumber.from(result.toTokenAmount).mul(1000).div(targetAmountOut).lt(995)
                    && ethers.BigNumber.from(result.toTokenAmount).gte(1000) // for dust amounts the 0.5% accuracy might not be possible
                ),
        );

        return {
            amount: amountFrom,
            payload: result.tx.data,
        };
    }
}

module.exports = EOASwapAndRepay;
