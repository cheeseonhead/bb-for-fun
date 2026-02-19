/** @param {NS} ns */

import { getBestTargets, isPrepped, getPrepNeeds, calculateBatchSize, calculateMoneyPerSec } from "/hack-v1/analyzer.js";

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
            const activeOperations = {}; // Track PIDs by target
            let opsScheduled = 0;
            for (const target of targets) {
                const hostname = target.hostname;

                // Check if target is prepped
                if (!isPrepped(ns, hostname)) {
                    // Schedule prep operations
                    const scheduled = schedulePrepOperations(ns, hostname, ramPool, activeOperations);
                    if (scheduled) opsScheduled++;
                } else {
                    // Schedule HWGW batch
                    const scheduled = scheduleHWGWBatch(ns, hostname, ramPool, activeOperations);
                    if (scheduled) opsScheduled++;
                }
            }

            // 5. Write status to port
            const status = {
                timestamp: Date.now(),
                ramPool: ramPool,
                targets: targets.slice(0, 5).map(t => {
                    const targetPrepped = isPrepped(ns, t.hostname);
                    const ops = activeOperations[t.hostname] || { hack: [], grow: [], weaken: [] };

                    return {
                        hostname: t.hostname,
                        score: t.score,
                        moneyPerSec: calculateMoneyPerSec(ns, t.hostname),
                        prepped: targetPrepped,
                        activelyWorked: (ops.hack.length + ops.grow.length + ops.weaken.length) > 0,
                        money: ns.getServerMoneyAvailable(t.hostname),
                        maxMoney: ns.getServerMaxMoney(t.hostname),
                        operations: {
                            hack: {
                                count: ops.hack.length,
                                threads: ops.hack.reduce((sum, o) => sum + o.threads, 0)
                            },
                            grow: {
                                count: ops.grow.length,
                                threads: ops.grow.reduce((sum, o) => sum + o.threads, 0)
                            },
                            weaken: {
                                count: ops.weaken.length,
                                threads: ops.weaken.reduce((sum, o) => sum + o.threads, 0)
                            }
                        }
                    };
                }),
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
 * @param {Object} activeOperations - Operation tracking object
 * @returns {boolean}
 */
function schedulePrepOperations(ns, target, ramPool, activeOperations) {
    const prepNeeds = getPrepNeeds(ns, target);

    // Initialize target in activeOperations if not exists
    if (!activeOperations[target]) {
        activeOperations[target] = { hack: [], grow: [], weaken: [] };
    }

    // Priority 1: Weaken to min security
    if (prepNeeds.weakenThreads > 0) {
        const deployments = scheduleOperation(ns, "weaken", target, prepNeeds.weakenThreads, ramPool);
        activeOperations[target].weaken.push(...deployments);
        return deployments.length > 0;
    }

    // Priority 2: Grow to max money
    if (prepNeeds.growThreads > 0) {
        const deployments = scheduleOperation(ns, "grow", target, prepNeeds.growThreads, ramPool);
        activeOperations[target].grow.push(...deployments);
        return deployments.length > 0;
    }

    return false;
}

/**
 * Schedule HWGW batch
 * @param {NS} ns
 * @param {string} target
 * @param {Array} ramPool
 * @param {Object} activeOperations - Operation tracking object
 * @returns {boolean}
 */
function scheduleHWGWBatch(ns, target, ramPool, activeOperations) {
    const batch = calculateBatchSize(ns, target, HACK_PERCENT);

    // Initialize target in activeOperations if not exists
    if (!activeOperations[target]) {
        activeOperations[target] = { hack: [], grow: [], weaken: [] };
    }

    // Schedule operations in sequence
    const hackDeployments = scheduleOperation(ns, "hack", target, batch.hackThreads, ramPool);
    const growDeployments = scheduleOperation(ns, "grow", target, batch.growThreads, ramPool);
    const weakenDeployments = scheduleOperation(ns, "weaken", target, batch.weakenThreads, ramPool);

    // Track deployments
    activeOperations[target].hack.push(...hackDeployments);
    activeOperations[target].grow.push(...growDeployments);
    activeOperations[target].weaken.push(...weakenDeployments);

    return hackDeployments.length > 0 || growDeployments.length > 0 || weakenDeployments.length > 0;
}

/**
 * Schedule an operation across available RAM
 * @param {NS} ns
 * @param {string} opType - "hack", "grow", or "weaken"
 * @param {string} target
 * @param {number} threads
 * @param {Array} ramPool
 * @returns {Array<{pid: number, host: string, threads: number}>} Array of deployed operations
 */
function scheduleOperation(ns, opType, target, threads, ramPool) {
    const workerScript = `/hack-v1/workers/${opType}.js`;
    let threadsRemaining = threads;
    const deployments = [];

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
                // Track this deployment
                deployments.push({
                    pid,
                    host: server.hostname,
                    threads: threadsToRun
                });

                // Update RAM tracking
                const ramUsed = threadsToRun * WORKER_RAM;
                server.freeRam -= ramUsed;
                server.usedRam += ramUsed;
                threadsRemaining -= threadsToRun;
            }
        } catch (error) {
            // Silently continue if exec fails
        }
    }

    return deployments;
}
