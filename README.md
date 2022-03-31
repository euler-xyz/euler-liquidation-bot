# Euler Liquidation Bot

Basic bot performing liquidations on the Euler platform. [Liquidation docs.](https://docs.euler.finance/getting-started/white-paper#liquidations)

### Installation

```bash
npm i
```

### Configuration

Configuration through `.env` file:

- `MAINNET_JSON_RPC_URL` - your JSON RPC provider endpoint (Infura, Rivet, Alchemy etc.)
- `MIN_ETH_YIELD` - minimum liquidation yield in ETH
- `PRV_KEY` - private key of the account executing EOA liquidations. The account needs to hold ETH to execute liquidation transactions.

Optionally the bot can be configured to push reports to Discord
- `DISCORD_WEBHOOK` - Discord webhook URL
- `DISCORD_AVATAR_URL` - Discord bot avatar URL
- `REPORTER_INTERVAL` - reporting interval in seconds

### Running

```bash
npx hardhat run scripts/mon.js --network mainnet
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
