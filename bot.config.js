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
      healthMax: process.env.QUERY_HEALTH_MAX ? Number(process.env.QUERY_HEALTH_MAX) : 1000000,
    },
    minYield: process.env.MIN_YIELD || '0.05',
  },
  mainnet: {
    eulerscan: {
      ws: process.env.EULERSCAN_WS || 'wss://escan-mainnet.euler.finance',
      queryLimit: process.env.QUERY_LIMIT ? Number(process.env.QUERY_LIMIT) : 500,
      healthMax: process.env.QUERY_HEALTH_MAX ? Number(process.env.QUERY_HEALTH_MAX) : 1000000,
    },
    reporter: {
      interval: process.env.REPORTER_INTERVAL ? Number(process.env.REPORTER_INTERVAL) : 60 * 60 * 1000,
      logPath: process.env.REPORTER_LOG_PATH || './log.txt',
    },
    minYield: process.env.MIN_YIELD || '0.05',
  },
}
