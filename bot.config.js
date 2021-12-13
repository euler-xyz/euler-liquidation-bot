module.exports = {
  localhost: {
    eulerscan: {
      ws: 'ws://localhost:8900',
    }
  },
  ropsten: {
    eulerscan: {
      ws: process.env.EULERSCAN_WS || 'wss://escan-ropsten.euler.finance',
      queryLimit: process.env.QUERY_LIMIT ? Number(process.env.QUERY_LIMIT) : 500,
      healthMax: process.env.HEALTH_MAX ? Number(process.env.HEALTH_MAX) : 15000000,
    },
  },
  mainnet: {
    eulerscan: {
      ws: process.env.EULERSCAN_WS || 'wss://escan-mainnet.euler.finance',
      queryLimit: process.env.QUERY_LIMIT ? Number(process.env.QUERY_LIMIT) : 500,
      healthMax: process.env.HEALTH_MAX ? Number(process.env.HEALTH_MAX) : 15000000,
    },
  },
}
