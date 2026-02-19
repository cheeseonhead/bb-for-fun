/** @param {NS} ns */

import { getBestTargets, isPrepped, getPrepNeeds, calculateBatchSize } from "/hack-v1/analyzer.js";

const PORT_SERVER_LIST = 1; // Input port from manager
const PORT_STATUS = 2; // Output port for status
const LOOP_DELAY = 10000; // 10 seconds
const WORKER_RAM = 1.75;
const HACK_PERCENT = 0.05; // Hack 5% of max money

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("Scheduler started");

    while (true) {
        try {
            // 1. Read server list from manager
            const serverListData = ns.peek(PORT_SERVER_LIST);
            if (serverListData === "NULL PORT DATA") {
                ns.print("Waiting for server list from manager...");
                await ns.sleep(LOOP_DELAY);
                continue;
            }

            const { servers } = JSON.parse(serverListData);

            // 2. Build RAM pool
            const ramPool = buildRamPool(ns, servers);

            if (ramPool.length === 0) {
                ns.print("No available RAM for operations");
                await ns.sleep(LOOP_DELAY);
                continue;
            }

            // 3. Get best targets
            const targets = getBestTargets(ns, 5);

            if (targets.length === 0) {
                ns.print("No valid targets found");
                await ns.sleep(LOOP_DELAY);
                continue;
            }

            // 4. Schedule operations for each target
            let opsScheduled = 0;
            for (const target of targets) {
                const hostname = target.hostname;

                // Check if target is prepped
                if (!isPrepped(ns, hostname)) {
                    // Schedule prep operations
                    const scheduled = schedulePrepOperations(ns, hostname, ramPool);
                    if (scheduled) opsScheduled++;
                } else {
                    // Schedule HWGW batch
                    const scheduled = scheduleHWGWBatch(ns, hostname, ramPool);
                    if (scheduled) opsScheduled++;
                }
            }

            // 5. Write status to port
            const status = {
                timestamp: Date.now(),
                ramPool: ramPool,
                targets: targets.slice(0, 5).map(t => ({
                    hostname: t.hostname,
                    prepped: isPrepped(ns, t.hostname),
                    money: ns.getServerMoneyAvailable(t.hostname),
                    maxMoney: ns.getServerMaxMoney(t.hostname)
                })),
                opsScheduled
            };
            ns.clearPort(PORT_STATUS);
            await ns.writePort(PORT_STATUS, JSON.stringify(status));

            ns.print(`Scheduled operations for ${opsScheduled} targets`);

            // 6. Sleep until next cycle
            await ns.sleep(LOOP_DELAY);

        } catch (error) {
            ns.print(`ERROR: ${error}`);
            await ns.sleep(LOOP_DELAY);
        }
    }
}

/**
 * Build RAM pool from all available servers
 * @param {NS} ns
 * @param {string[]} servers
 * @returns {Array<{hostname: string, maxRam: number, usedRam: number, freeRam: number}>}
 */
function buildRamPool(ns, servers) {
    const pool = [];

    for (const hostname of servers) {
        // Only use servers we have root on
        if (!ns.hasRootAccess(hostname)) {
            continue;
        }

        const maxRam = ns.getServerMaxRam(hostname);
        const usedRam = ns.getServerUsedRam(hostname);
        const freeRam = maxRam - usedRam;

        // Reserve RAM on home server for launcher/manager/scheduler
        if (hostname === "home") {
            const reservedRam = 20; // Reserve for system scripts
            const adjustedFree = Math.max(0, freeRam - reservedRam);
            if (adjustedFree > WORKER_RAM) {
                pool.push({
                    hostname,
                    maxRam,
                    usedRam: usedRam + reservedRam,
                    freeRam: adjustedFree
                });
            }
        } else if (freeRam > WORKER_RAM) {
            pool.push({ hostname, maxRam, usedRam, freeRam });
        }
    }

    // Sort by free RAM descending
    pool.sort((a, b) => b.freeRam - a.freeRam);

    return pool;
}

/**
 * Schedule prep operations (weaken/grow)
 * @param {NS} ns
 * @param {string} target
 * @param {Array} ramPool
 * @returns {boolean}
 */
function schedulePrepOperations(ns, target, ramPool) {
    const prepNeeds = getPrepNeeds(ns, target);

    // Priority 1: Weaken to min security
    if (prepNeeds.weakenThreads > 0) {
        return scheduleOperation(ns, "weaken", target, prepNeeds.weakenThreads, ramPool);
    }

    // Priority 2: Grow to max money
    if (prepNeeds.growThreads > 0) {
        return scheduleOperation(ns, "grow", target, prepNeeds.growThreads, ramPool);
    }

    return false;
}

/**
 * Schedule HWGW batch
 * @param {NS} ns
 * @param {string} target
 * @param {Array} ramPool
 * @returns {boolean}
 */
function scheduleHWGWBatch(ns, target, ramPool) {
    const batch = calculateBatchSize(ns, target, HACK_PERCENT);

    // Schedule operations in sequence
    const hackOk = scheduleOperation(ns, "hack", target, batch.hackThreads, ramPool);
    const growOk = scheduleOperation(ns, "grow", target, batch.growThreads, ramPool);
    const weakenOk = scheduleOperation(ns, "weaken", target, batch.weakenThreads, ramPool);

    return hackOk || growOk || weakenOk;
}

/**
 * Schedule an operation across available RAM
 * @param {NS} ns
 * @param {string} opType - "hack", "grow", or "weaken"
 * @param {string} target
 * @param {number} threads
 * @param {Array} ramPool
 * @returns {boolean} True if at least some threads scheduled
 */
function scheduleOperation(ns, opType, target, threads, ramPool) {
    const workerScript = `/hack-v1/workers/${opType}.js`;
    let threadsRemaining = threads;
    let anyScheduled = false;

    for (const server of ramPool) {
        if (threadsRemaining <= 0) {
            break;
        }

        const threadsAvailable = Math.floor(server.freeRam / WORKER_RAM);
        if (threadsAvailable <= 0) {
            continue;
        }

        const threadsToRun = Math.min(threadsRemaining, threadsAvailable);

        try {
            const pid = ns.exec(workerScript, server.hostname, threadsToRun, target);

            if (pid > 0) {
                // Update RAM tracking
                const ramUsed = threadsToRun * WORKER_RAM;
                server.freeRam -= ramUsed;
                server.usedRam += ramUsed;
                threadsRemaining -= threadsToRun;
                anyScheduled = true;
            }
        } catch (error) {
            // Silently continue if exec fails
        }
    }

    return anyScheduled;
}
