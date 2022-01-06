const fs = require('fs');
const discord = require('./discordBot');

module.exports = class {
    YIELD_TOO_LOW = 1;
    NO_OPPORTUNITY_FOUND = 2;
    LIQUIDATION = 3;
    ERROR = 4;

    constructor(config) {
        this.reportingDisabled = !config;
        if (config) {
            this.logPath = config.logPath;
            this.nextReport = {};
            setInterval(() => this.report(), config.interval);
        }
    }

    report() {
        const countEvent = (events, type) => events.filter(e => e.type === type).length;
        let rep = Object.entries(this.nextReport).map(([account, events]) => {
            const yieldTooLowCount = countEvent(events, this.YIELD_TOO_LOW)
            let latestYield = ''
            if (yieldTooLowCount) {
                latestYield = events.filter(e => e.type === this.YIELD_TOO_LOW).pop().yield
            }
            let msg = '';
            msg = `${account} HS: ${events[events.length - 1].account.healthScore / 1000000} `;
            msg += `Yield too low: ${yieldTooLowCount}${yieldTooLowCount && ` (${ethers.utils.formatEther(latestYield)}) ` }`;
            msg += `No opportunity found: ${countEvent(events, this.NO_OPPORTUNITY_FOUND)} `;
            msg += `Liquidation: ${countEvent(events, this.LIQUIDATION)} `;
            msg += `Error: ${countEvent(events, this.ERROR)} `;
            return msg;
        })

        discord(rep.length ? `\`\`\`REPORT ${(new Date()).toISOString()}\n${rep.join('\n')}\`\`\`` : 'Nothing to report');

        this.nextReport = {};
    }

    log(event) {
        event = {
            ...event,
            time: (new Date()).toISOString(),
        }
        console.log(this.describeEvent(event));

        if (this.reportingDisabled) return;

        if (!this.nextReport[event.account.account]) this.nextReport[event.account.account] = []
        this.nextReport[event.account.account].push(event);

        if ([this.LIQUIDATION, this.ERROR].includes(event.type)) {
            discord(this.describeEvent(event));
        }

        fs.appendFileSync(this.logPath, this.describeEvent(event) + '\n');
    }

    describeEvent(event) {
        const msg = `${event.time} Account: ${event.account.account} HS: ${event.account.healthScore / 1000000}`
        switch (event.type) {
            case this.YIELD_TOO_LOW:
                return `${msg} Yield too low (${ethers.utils.formatEther(event.yield)} ETH, required ${event.required} ETH)`;
            case this.NO_OPPORTUNITY_FOUND:
                return `${msg} No liquidation opportunity found`;
            case this.ERROR:
                return `${msg} ERROR ${event.error} strategy: ${event.strategy}`;
            case this.LIQUIDATION:
                return `${msg} LIQUIDATION COMPLETED ${event.tx.transactionHash} balance left: ${ethers.utils.formatEther(event.balanceLeft)} ${event.strategy}`;
        }
    }
}
