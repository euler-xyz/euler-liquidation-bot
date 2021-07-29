require("@nomiclabs/hardhat-waffle");


// Config

module.exports = {
    networks: {
        hardhat: {
            hardfork: 'berlin',
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
};
