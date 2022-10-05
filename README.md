# Euler Liquidation Bot

Basic bot performing liquidations on the Euler platform. [Liquidation docs.](https://docs.euler.finance/getting-started/white-paper#liquidations)

### Installation

```bash
npm i
```

### Configuration

Configuration through `.env` file:

- `MAINNET_JSON_RPC_URL` - your JSON RPC provider endpoint (Infura, Rivet, Alchemy etc.).
- `MIN_ETH_YIELD` - minimum liquidation yield in ETH. Default `0.05`.
- `PRV_KEY` - private key of the account executing EOA liquidations. The account needs to hold ETH to execute liquidation transactions.
- `RECEIVER_SUBACCOUNT_ID` - optional ID of a sub-account to which the yield will be transfered after liquidation.
- `ONEINCH_API_URL` - optional [1inch swap](https://docs.1inch.io/docs/aggregation-protocol/api/swap-params) API URL. If set, the bot will try to swap as much collateral as possible first on 1inch, presumably at better rates, and the remainder on Uni V3 exact output.
- `SKIP_ACCOUNTS_WITH_INSUFFICIENT_COLLATERAL` optional, if set to string `true`, skip processing accounts with largest deposited collateral value less than the MIN_ETH_YIELD. 

Optional - gas settings
- `TX_FEE_MUL` - transaction fee multiplier. Default `maxFeePerGas` and `maxPriorityFeePerGas` [returned by provider](https://docs.ethers.io/v5/api/providers/provider/#Provider-getFeeData) will be multiplied by this value.
- `TX_GAS_LIMIT` - custom `gasLimit`.

Optional - the bot can be configured to push reports to Discord
- `DISCORD_WEBHOOK` - discord webhook URL.
- `REPORTER_INTERVAL` - reporting interval in seconds.

Optional - send transactions through flashbots
- `USE_FLASHBOTS` - if set to a string `true`, send the final liquidation tx through flashbots. Default `false`.
- `FLASHBOTS_RELAY_SIGNING_KEY` - key used to identify the searcher in flashbots relay. If not set a random wallet will be generated.
- `FLASHBOTS_MAX_BLOCKS` - sets the number of blocks during which flashbots will try to include the tx. If not set, flasbots default 25 blocks will be used.
- `FLASHBOTS_DISABLE_FALLBACK` - by default, if flashbots call fails, the liquidation bot will attempt to send a regular tx. Set to string `true` to disable this behaviour.

### Running

```bash
npm start
```

### Tests

```bash
npx hardhat test
```

### Dependencies

The bot depends on Eulerscan project, maintained by Euler, to receive updates about accounts in violation (healthscore < 1). Eulerscan provides a websocket connection through which JSON Patch updates to subscribed data are pushed. It is publicly available on `wss://escan-mainnet.euler.finance`.

### Bot algorithm

The main bot logic simulates liquidations through multiple strategies and parameters to find the best candidate. Two strategies were explored, of which only EOA is currently executed:

- EOA strategy. Liquidations are performed by constructing batch transactions to Euler's [Exec contract](https://github.com/euler-xyz/euler-contracts/blob/master/contracts/modules/Exec.sol), which are executed by EAO from `PRV_KEY` configuration.
- Bot contract strategy. A rudimentary `LiquidationBot` contract is included in the repo. Only basic tests are available. Currently not used in production.
