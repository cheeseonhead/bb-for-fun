/** @param {NS} ns */

import { scanAllServers, rootServer, shouldPurchaseServer, purchaseAndSetup } from "/server-manager.js";
import { getBestTargets, isPrepped, getPrepNeeds, calculateBatchSize } from "/analyzer.js";
import { deployWorkers } from "/deploy.js";

const WORKER_RAM = 1.75;
const LOOP_DELAY = 10000; // 10 seconds
const HACK_PERCENT = 0.05; // Hack 5% of max money

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.clearLog();

    ns.tprint("Starting Distributed HWGW System...");

    // Track known servers to detect new ones
    let knownServers = new Set();

    while (true) {
        try {
            // 1. Scan network for all servers
            const allServers = scanAllServers(ns);

            // 2. Root any new hackable servers
            for (const server of allServers) {
                if (!knownServers.has(server)) {
                    const rooted = rootServer(ns, server);
                    if (rooted) {
                        ns.print(`Rooted: ${server}`);
                    }
                    knownServers.add(server);
                }
            }

            // 3. Deploy workers to new servers
            await deployWorkers(ns, allServers);

            // 4. Check for server purchase opportunities
            const purchaseDecision = shouldPurchaseServer(ns);
            if (purchaseDecision.purchase) {
                const hostname = purchaseAndSetup(ns, purchaseDecision.ram, purchaseDecision.name);
                if (hostname) {
                    knownServers.add(hostname);
                    await deployWorkers(ns, [hostname]);
                }
            }

            // 5. Build RAM pool
            const ramPool = buildRamPool(ns, allServers);

            // 6. Get best targets
            const targets = getBestTargets(ns, 5);

            if (targets.length === 0) {
                ns.print("No valid targets found");
                await ns.sleep(LOOP_DELAY);
                continue;
            }

            // 7. Schedule operations for each target
            for (const target of targets) {
                const hostname = target.hostname;

                // Check if target is prepped
                if (!isPrepped(ns, hostname)) {
                    // Schedule prep operations
                    schedulePrepOperations(ns, hostname, ramPool);
                } else {
                    // Schedule HWGW batch
                    scheduleHWGWBatch(ns, hostname, ramPool);
                }
            }

            // Log status
            logStatus(ns, ramPool, targets);

            // 8. Sleep until next cycle
            await ns.sleep(LOOP_DELAY);

        } catch (error) {
            ns.tprint(`ERROR: ${error}`);
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

        // Reserve RAM on home server for orchestrator
        if (hostname === "home") {
            const reservedRam = 30; // Reserve for orchestrator and utilities
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
 */
function schedulePrepOperations(ns, target, ramPool) {
    const prepNeeds = getPrepNeeds(ns, target);

    // Priority 1: Weaken to min security
    if (prepNeeds.weakenThreads > 0) {
        scheduleOperation(ns, "weaken", target, prepNeeds.weakenThreads, ramPool);
        return;
    }

    // Priority 2: Grow to max money
    if (prepNeeds.growThreads > 0) {
        scheduleOperation(ns, "grow", target, prepNeeds.growThreads, ramPool);
        return;
    }
}

/**
 * Schedule HWGW batch
 * @param {NS} ns
 * @param {string} target
 * @param {Array} ramPool
 */
function scheduleHWGWBatch(ns, target, ramPool) {
    const batch = calculateBatchSize(ns, target, HACK_PERCENT);

    // Schedule operations in sequence
    scheduleOperation(ns, "hack", target, batch.hackThreads, ramPool);
    scheduleOperation(ns, "grow", target, batch.growThreads, ramPool);
    scheduleOperation(ns, "weaken", target, batch.weakenThreads, ramPool);
}

/**
 * Schedule an operation across available RAM
 * @param {NS} ns
 * @param {string} opType - "hack", "grow", or "weaken"
 * @param {string} target
 * @param {number} threads
 * @param {Array} ramPool
 * @returns {boolean} True if fully scheduled
 */
function scheduleOperation(ns, opType, target, threads, ramPool) {
    const workerScript = `/workers/${opType}.js`;
    let threadsRemaining = threads;

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
            }
        } catch (error) {
            // Silently continue if exec fails
        }
    }

    return threadsRemaining === 0;
}

/**
 * Log current status
 * @param {NS} ns
 * @param {Array} ramPool
 * @param {Array} targets
 */
function logStatus(ns, ramPool, targets) {
    ns.clearLog();

    // Calculate total RAM
    const totalRam = ramPool.reduce((sum, s) => sum + s.maxRam, 0);
    const usedRam = ramPool.reduce((sum, s) => sum + s.usedRam, 0);
    const freeRam = ramPool.reduce((sum, s) => sum + s.freeRam, 0);
    const utilization = totalRam > 0 ? (usedRam / totalRam * 100).toFixed(1) : 0;

    ns.print(`=== HWGW System Status ===`);
    ns.print(`RAM: ${usedRam.toFixed(1)}/${totalRam.toFixed(1)} GB (${utilization}% util)`);
    ns.print(`Servers in pool: ${ramPool.length}`);
    ns.print(``);

    // Show targets
    ns.print(`Active Targets:`);
    for (let i = 0; i < Math.min(5, targets.length); i++) {
        const target = targets[i];
        const prepped = isPrepped(ns, target.hostname);
        const status = prepped ? "PREPPED" : "PREPPING";
        const money = ns.getServerMoneyAvailable(target.hostname);
        const maxMoney = ns.getServerMaxMoney(target.hostname);
        const moneyPct = maxMoney > 0 ? (money / maxMoney * 100).toFixed(0) : 0;

        ns.print(`${i + 1}. ${target.hostname} [${status}] $${ns.formatNumber(money)} (${moneyPct}%)`);
    }

    ns.print(``);
    ns.print(`Player Money: $${ns.formatNumber(ns.getServerMoneyAvailable("home"))}`);
}
