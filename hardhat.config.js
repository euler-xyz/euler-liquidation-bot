require("@nomiclabs/hardhat-waffle");
require('hardhat-dependency-compiler');


// Config
let accounts = process.env.PRV_KEY ? { accounts: [process.env.PRV_KEY] } : {};

module.exports = {
    networks: {
        hardhat: {
            hardfork: 'london',
        },
        ropsten: {
            url: 'https://cc7e3c40266c4dd99caa9ae00a308681.ropsten.rpc.rivet.cloud/',
            ...accounts,
        },
        mainnet: {
            url: 'https://fbb217c5cb464dd98a5cd5c53d49eda4.eth.rpc.rivet.cloud/',
            ...accounts,
        },
    },

    solidity: {
        compilers: [
            {
                version: "0.8.6",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 1000000,
                    },
                },
            },
        ],
    },

    dependencyCompiler: {
        paths: [
            'euler-contracts/contracts/Euler.sol',
            'euler-contracts/contracts/modules/DToken.sol',
            'euler-contracts/contracts/modules/EToken.sol',
            'euler-contracts/contracts/modules/Exec.sol',
            'euler-contracts/contracts/modules/Governance.sol',
            'euler-contracts/contracts/modules/Installer.sol',
            'euler-contracts/contracts/modules/Liquidation.sol',
            'euler-contracts/contracts/modules/Markets.sol',
            'euler-contracts/contracts/modules/RiskManager.sol',
            'euler-contracts/contracts/modules/Swap.sol',
            'euler-contracts/contracts/modules/interest-rate-models/IRMDefault.sol',
            'euler-contracts/contracts/modules/interest-rate-models/IRMClassMajor.sol',
            'euler-contracts/contracts/modules/interest-rate-models/IRMClassMidCap.sol',
            'euler-contracts/contracts/modules/interest-rate-models/IRMClassStable.sol',
            'euler-contracts/contracts/modules/interest-rate-models/test/IRMZero.sol',
            'euler-contracts/contracts/modules/interest-rate-models/test/IRMFixed.sol',
            'euler-contracts/contracts/modules/interest-rate-models/test/IRMLinear.sol',
            'euler-contracts/contracts/adaptors/FlashLoan.sol',
            'euler-contracts/contracts/test/FlashLoanAdaptorTest2.sol',
            'euler-contracts/contracts/test/FlashLoanAdaptorTest.sol',
            'euler-contracts/contracts/test/FlashLoanNativeTest.sol',
            'euler-contracts/contracts/test/InvariantChecker.sol',
            'euler-contracts/contracts/test/JunkETokenUpgrade.sol',
            'euler-contracts/contracts/test/JunkMarketsUpgrade.sol',
            'euler-contracts/contracts/test/MockUniswapV3Factory.sol',
            'euler-contracts/contracts/test/MockUniswapV3Pool.sol',
            'euler-contracts/contracts/test/SimpleUniswapPeriphery.sol',
            'euler-contracts/contracts/test/TestERC20.sol',
            'euler-contracts/contracts/test/TestModule.sol',
            'euler-contracts/contracts/views/EulerGeneralView.sol',
            'euler-contracts/contracts/mining/EulDistributor.sol',
            'euler-contracts/contracts/mining/EulStakes.sol',
        ],
    }
};
