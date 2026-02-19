/** @param {NS} ns */

import { getBestTargets, isPrepped, getPrepNeeds, calculateBatchSize, calculateMoneyPerSec } from "/hack-v1/analyzer.js";

const PORT_SERVER_LIST = 1; // Input port from manager
const PORT_SCHEDULER_STATE = 4; // Output port for shared state
const WORKER_RAM = 1.75;
const HACK_PERCENT = 0.05; // Hack 5% of max money

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("Scheduler started");

    const SCHEDULE_DELAY = 10000; // 10 seconds
    let iteration = 0;

    while (true) {
        try {
            iteration++;
            ns.print(`[Scheduling ${iteration}] Starting...`);

            // Read server list from manager
            const serverListData = ns.peek(PORT_SERVER_LIST);
            if (serverListData === "NULL PORT DATA") {
                ns.print("Waiting for server list from manager...");
                await ns.sleep(SCHEDULE_DELAY);
                continue;
            }

            const { servers } = JSON.parse(serverListData);

            // Build RAM pool
            const ramPool = buildRamPool(ns, servers);

            if (ramPool.length === 0) {
                ns.print("No available RAM for operations");

                // Still publish state for status reporter
                const state = { servers, targets: [], operationStartTimes: {}, timestamp: Date.now() };
                ns.clearPort(PORT_SCHEDULER_STATE);
                await ns.writePort(PORT_SCHEDULER_STATE, JSON.stringify(state));

                await ns.sleep(SCHEDULE_DELAY);
                continue;
            }

            // Get best targets
            const targets = getBestTargets(ns, 5);

            if (targets.length === 0) {
                ns.print("No valid targets found");

                // Publish empty state
                const state = { servers, targets: [], operationStartTimes: {}, timestamp: Date.now() };
                ns.clearPort(PORT_SCHEDULER_STATE);
                await ns.writePort(PORT_SCHEDULER_STATE, JSON.stringify(state));

                await ns.sleep(SCHEDULE_DELAY);
                continue;
            }

            // Prepare targets with pre-calculated moneyPerSec
            const targetsWithMoney = targets.map(t => ({
                hostname: t.hostname,
                score: t.score,
                moneyPerSec: calculateMoneyPerSec(ns, t.hostname)
            }));

            // Schedule operations for each target
            const operationStartTimes = {}; // Track PIDs and start times
            let opsScheduled = 0;

            for (const target of targets) {
                const hostname = target.hostname;

                if (!isPrepped(ns, hostname)) {
                    const scheduled = schedulePrepOperations(ns, hostname, ramPool, operationStartTimes);
                    if (scheduled) opsScheduled++;
                } else {
                    const scheduled = scheduleHWGWBatch(ns, hostname, ramPool, operationStartTimes);
                    if (scheduled) opsScheduled++;
                }
            }

            ns.print(`Scheduled operations for ${opsScheduled} targets`);

            // Publish state for status reporter
            const state = {
                servers,
                targets: targetsWithMoney,
                operationStartTimes,
                timestamp: Date.now()
            };
            ns.clearPort(PORT_SCHEDULER_STATE);
            await ns.writePort(PORT_SCHEDULER_STATE, JSON.stringify(state));

            await ns.sleep(SCHEDULE_DELAY);

        } catch (error) {
            ns.print(`[Scheduling ${iteration}] ERROR: ${error}`);
            ns.print(`Stack: ${error.stack || 'No stack trace'}`);
            await ns.sleep(SCHEDULE_DELAY);
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
 * @param {Object} operationStartTimes - Map to track PIDs
 * @returns {boolean}
 */
function schedulePrepOperations(ns, target, ramPool, operationStartTimes) {
    const prepNeeds = getPrepNeeds(ns, target);

    // Priority 1: Weaken to min security
    if (prepNeeds.weakenThreads > 0) {
        const deployments = scheduleOperation(ns, "weaken", target, prepNeeds.weakenThreads, ramPool, operationStartTimes);
        return deployments.length > 0;
    }

    // Priority 2: Grow to max money
    if (prepNeeds.growThreads > 0) {
        const deployments = scheduleOperation(ns, "grow", target, prepNeeds.growThreads, ramPool, operationStartTimes);
        return deployments.length > 0;
    }

    return false;
}

/**
 * Schedule HWGW batch
 * @param {NS} ns
 * @param {string} target
 * @param {Array} ramPool
 * @param {Object} operationStartTimes - Map to track PIDs
 * @returns {boolean}
 */
function scheduleHWGWBatch(ns, target, ramPool, operationStartTimes) {
    const batch = calculateBatchSize(ns, target, HACK_PERCENT);

    // Schedule operations in sequence
    const hackDeployments = scheduleOperation(ns, "hack", target, batch.hackThreads, ramPool, operationStartTimes);
    const growDeployments = scheduleOperation(ns, "grow", target, batch.growThreads, ramPool, operationStartTimes);
    const weakenDeployments = scheduleOperation(ns, "weaken", target, batch.weakenThreads, ramPool, operationStartTimes);

    return hackDeployments.length > 0 || growDeployments.length > 0 || weakenDeployments.length > 0;
}

/**
 * Schedule an operation across available RAM
 * @param {NS} ns
 * @param {string} opType - "hack", "grow", or "weaken"
 * @param {string} target
 * @param {number} threads
 * @param {Array} ramPool
 * @param {Object} operationStartTimes - Map to track PIDs
 * @returns {Array<{pid: number, host: string, threads: number}>} Array of deployed operations
 */
function scheduleOperation(ns, opType, target, threads, ramPool, operationStartTimes) {
    const workerScript = `/hack-v1/workers/${opType}.js`;
    let threadsRemaining = threads;
    const deployments = [];
    const startTime = Date.now(); // Track when scheduled

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

                // Record start time for countdown tracking
                operationStartTimes[pid] = {
                    target: target,
                    type: opType,
                    startTime: startTime
                };

                // Update RAM tracking
                const ramUsed = threadsToRun * WORKER_RAM;
                server.freeRam -= ramUsed;
                server.usedRam += ramUsed;
                threadsRemaining -= threadsToRun;
            } else {
                // exec returned 0 - failed to start
                ns.print(`Failed to exec ${workerScript} on ${server.hostname} (${threadsToRun}t for ${target})`);
            }
        } catch (error) {
            ns.print(`Error executing ${workerScript} on ${server.hostname}: ${error}`);
        }
    }

    return deployments;
}
