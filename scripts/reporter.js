const fs = require('fs');
const discord = require('./discordBot');
const ethers = require('ethers')

module.exports = class {
    YIELD_TOO_LOW = 1;
    NO_OPPORTUNITY_FOUND = 2;
    LIQUIDATION = 3;
    ERROR = 4;

    constructor(config) {
        this.reportingDisabled = !config;
        this.nextReport = {};
        if (config) {
            this.logPath = config.logPath;
            setInterval(() => this.report(), config.interval * 1000);
        }
    }

    async report() {
        const countEvent = (events, type) => events.filter(e => e.type === type).length;
        let skipped = 0
        let rep = Object.entries(this.nextReport).map(([account, events]) => {

            // account in violation after FTX BF decrease
            if (account.toLowerCase() === '0xfe32a37f15ee4a4b59715530e5817d1322b9df80') {
                return null
            }
            // console.log('events: ', events);
            const yieldTooLowCount = countEvent(events, this.YIELD_TOO_LOW);
            const totalCollateral = parseFloat(ethers.utils.formatEther(events[events.length - 1].account.totalCollateral)).toFixed(3);
            if (Number(totalCollateral) < 0.5) {
                skipped++;
                return null;
            }
            const totalLiabilities = parseFloat(ethers.utils.formatEther(events[events.length - 1].account.totalLiabilities)).toFixed(3);
            let latestYield = '';
            if (yieldTooLowCount) {
                latestYield = events.filter(e => e.type === this.YIELD_TOO_LOW).pop().yield;
            }
            let msg = '';
            msg = `${account} HS: ${events[events.length - 1].account.healthScore / 1000000} \n`;
            msg += `Total collateral ETH: ${totalCollateral}, Total liabilities ETH: ${totalLiabilities} \n`
            msg += `Yield: ${yieldTooLowCount}${yieldTooLowCount && ` (${parseFloat(ethers.utils.formatEther(latestYield)).toFixed(6)}) ` }`;
            msg += `No op: ${countEvent(events, this.NO_OPPORTUNITY_FOUND)} `;
            msg += `Error: ${countEvent(events, this.ERROR)} \n`;
            return msg;
        }).filter(Boolean)

        if (rep.length === 0 && skipped === 0) {
            await discord('Nothing to report');
        } else {
            rep.unshift(`REPORT ${(new Date()).toISOString()}`);
            rep.push(`Skipped small accounts: ${skipped}`)
            let buff = []
            const parts = [];
            rep.forEach(r => {
                if ([...buff, r].join('\n').length < 2000) {
                    buff.push(r);
                } else {
                    parts.push([...buff]);
                    buff = [r];
                }
            })
            parts.push(buff);

            for (const p of parts) {
                await discord(`\`\`\`${p.join('\n')}\`\`\``);
                // console.log(`\`\`\`${p.join('\n')}\`\`\``);
            }
        }

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
            discord('@here ' + this.describeEvent(event));
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
                return `${msg} LIQUIDATION COMPLETED ${event.tx.transactionHash || event.tx.transaction?.hash } balance left: ${ethers.utils.formatEther(event.balanceLeft)} ${event.strategy}`;
        }
    }
}
