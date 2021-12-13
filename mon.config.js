module.exports = {
  localhost: {
    eulerscan: {
      ws: 'ws://localhost:8900',
    }
  },
  ropsten: {
    eulerscan: {
      ws: 'wss://escan-ropsten.euler.finance',
      queryLimit: 500,
      healthMax: 15000000,
    },
  },
  mainnet: {
    eulerscan: {
      ws: 'wss://escan-mainnet.euler.finance',
      queryLimit: 500,
      healthMax: 15000000,
    },
  },
}
