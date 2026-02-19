/** @param {NS} ns */

import { getBestTargets, isPrepped, getPrepNeeds, calculateBatchSize, calculateMoneyPerSec } from "/hack-v1/analyzer.js";

const PORT_SERVER_LIST = 1; // Input port from manager
const PORT_STATUS = 2; // Output port for status
const LOOP_DELAY = 10000; // 10 seconds
const WORKER_RAM = 1.75;
const HACK_PERCENT = 0.05; // Hack 5% of max money

// Shared state between loops
let sharedState = {
    targets: [],
    servers: [],
    lastScheduleTime: 0,
    operationStartTimes: {} // Track when operations started { pid: { target, type, startTime } }
};

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("Scheduler started");

    try {
        // Launch both loops concurrently
        ns.print("Creating scheduling loop promise...");
        const schedulingPromise = schedulingLoop(ns);
        ns.print("Creating status loop promise...");
        const statusPromise = statusReportingLoop(ns);

        ns.print("Both promises created, waiting on Promise.all...");
        // Wait for both (they run forever)
        await Promise.all([schedulingPromise, statusPromise]);

        ns.print("Promise.all completed (this should never happen)");
    } catch (error) {
        ns.print(`CRITICAL ERROR in main: ${error}`);
        ns.print(`Stack: ${error.stack || 'No stack trace'}`);
        throw error; // Re-throw so we can see it
    }
}

/**
 * Scheduling loop - runs every 10 seconds
 * @param {NS} ns
 */
async function schedulingLoop(ns) {
    const SCHEDULE_DELAY = 10000; // 10 seconds
    let iteration = 0;

    while (true) {
        try {
            iteration++;
            ns.print(`[Scheduling Loop ${iteration}] Starting...`);

            // Read server list from manager
            const serverListData = ns.peek(PORT_SERVER_LIST);
            if (serverListData === "NULL PORT DATA") {
                ns.print("Waiting for server list from manager...");
                await ns.sleep(SCHEDULE_DELAY);
                continue;
            }

            const { servers } = JSON.parse(serverListData);

            // Update shared state immediately so status loop has it even if no RAM available
            sharedState.servers = servers;
            sharedState.lastScheduleTime = Date.now();

            // Build RAM pool
            const ramPool = buildRamPool(ns, servers);

            if (ramPool.length === 0) {
                ns.print("No available RAM for operations");
                await ns.sleep(SCHEDULE_DELAY);
                continue;
            }

            // Get best targets
            const targets = getBestTargets(ns, 5);

            if (targets.length === 0) {
                ns.print("No valid targets found");
                await ns.sleep(SCHEDULE_DELAY);
                continue;
            }

            // Update shared state targets for status loop
            sharedState.targets = targets.map(t => ({
                hostname: t.hostname,
                score: t.score,
                moneyPerSec: calculateMoneyPerSec(ns, t.hostname) // Calculate once here
            }));

            // Schedule operations for each target
            let opsScheduled = 0;
            for (const target of targets) {
                const hostname = target.hostname;

                if (!isPrepped(ns, hostname)) {
                    const scheduled = schedulePrepOperations(ns, hostname, ramPool);
                    if (scheduled) opsScheduled++;
                } else {
                    const scheduled = scheduleHWGWBatch(ns, hostname, ramPool);
                    if (scheduled) opsScheduled++;
                }
            }

            ns.print(`Scheduled operations for ${opsScheduled} targets`);
            ns.print(`[Scheduling Loop ${iteration}] Complete, sleeping ${SCHEDULE_DELAY}ms`);

            await ns.sleep(SCHEDULE_DELAY);

        } catch (error) {
            ns.print(`[Scheduling Loop ${iteration}] ERROR: ${error}`);
            ns.print(`Stack: ${error.stack || 'No stack trace'}`);
            await ns.sleep(SCHEDULE_DELAY);
        }
    }
}

/**
 * Status reporting loop - runs every 1 second
 * @param {NS} ns
 */
async function statusReportingLoop(ns) {
    ns.print("=== STATUS LOOP FUNCTION CALLED ===");
    const STATUS_DELAY = 1000; // 1 second
    let iteration = 0;

    while (true) {
        try {
            iteration++;
            ns.print(`[Status Loop ${iteration}] Starting...`);

            // Wait for initial scheduling to populate targets
            if (!sharedState.targets || sharedState.targets.length === 0) {
                ns.print(`[Status Loop ${iteration}] No targets yet, sleeping`);
                await ns.sleep(STATUS_DELAY);
                continue;
            }

            // Ensure servers array exists
            if (!sharedState.servers || sharedState.servers.length === 0) {
                ns.print(`[Status Loop ${iteration}] No servers in shared state, sleeping`);
                await ns.sleep(STATUS_DELAY);
                continue;
            }

            // Build RAM pool (quick, just reads server stats)
            const ramPool = buildRamPool(ns, sharedState.servers);

            // Query actual running operations
            const targetHostnames = sharedState.targets.map(t => t.hostname);
            const activeOperations = getActiveOperations(ns, targetHostnames);

            // Build status
            const status = {
                timestamp: Date.now(),
                ramPool: ramPool,
                targets: sharedState.targets.slice(0, 5).map(t => {
                    const targetPrepped = isPrepped(ns, t.hostname);
                    const ops = activeOperations[t.hostname] || { hack: [], grow: [], weaken: [] };

                    return {
                        hostname: t.hostname,
                        score: t.score,
                        moneyPerSec: t.moneyPerSec, // Use pre-calculated value
                        prepped: targetPrepped,
                        activelyWorked: (ops.hack.length + ops.grow.length + ops.weaken.length) > 0,
                        money: ns.getServerMoneyAvailable(t.hostname),
                        maxMoney: ns.getServerMaxMoney(t.hostname),
                        operations: {
                            hack: {
                                count: ops.hack.length,
                                threads: ops.hack.reduce((sum, o) => sum + o.threads, 0),
                                maxTimeRemaining: ops.hack.length > 0 ? Math.max(...ops.hack.map(o => o.timeRemaining)) : 0
                            },
                            grow: {
                                count: ops.grow.length,
                                threads: ops.grow.reduce((sum, o) => sum + o.threads, 0),
                                maxTimeRemaining: ops.grow.length > 0 ? Math.max(...ops.grow.map(o => o.timeRemaining)) : 0
                            },
                            weaken: {
                                count: ops.weaken.length,
                                threads: ops.weaken.reduce((sum, o) => sum + o.threads, 0),
                                maxTimeRemaining: ops.weaken.length > 0 ? Math.max(...ops.weaken.map(o => o.timeRemaining)) : 0
                            }
                        }
                    };
                }),
                opsScheduled: sharedState.targets.length
            };

            ns.clearPort(PORT_STATUS);
            await ns.writePort(PORT_STATUS, JSON.stringify(status));

            ns.print(`[Status Loop ${iteration}] Complete, sleeping ${STATUS_DELAY}ms`);
            await ns.sleep(STATUS_DELAY);

        } catch (error) {
            ns.print(`[Status Loop ${iteration}] ERROR: ${error}`);
            ns.print(`Stack: ${error.stack || 'No stack trace'}`);
            await ns.sleep(STATUS_DELAY);
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
        const deployments = scheduleOperation(ns, "weaken", target, prepNeeds.weakenThreads, ramPool);
        return deployments.length > 0;
    }

    // Priority 2: Grow to max money
    if (prepNeeds.growThreads > 0) {
        const deployments = scheduleOperation(ns, "grow", target, prepNeeds.growThreads, ramPool);
        return deployments.length > 0;
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
    const hackDeployments = scheduleOperation(ns, "hack", target, batch.hackThreads, ramPool);
    const growDeployments = scheduleOperation(ns, "grow", target, batch.growThreads, ramPool);
    const weakenDeployments = scheduleOperation(ns, "weaken", target, batch.weakenThreads, ramPool);

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
                sharedState.operationStartTimes[pid] = {
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

/**
 * Helper to get all servers (BFS scan)
 * @param {NS} ns
 * @returns {string[]}
 */
function getAllServers(ns) {
    const queue = ["home"];
    const visited = new Set(["home"]);
    const servers = [];

    while (queue.length > 0) {
        const current = queue.shift();
        servers.push(current);

        const neighbors = ns.scan(current);
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    return servers;
}

/**
 * Query running operations and calculate time remaining
 * @param {NS} ns
 * @param {string[]} targetHostnames
 * @returns {Object} Active operations by target
 */
function getActiveOperations(ns, targetHostnames) {
    const activeOps = {};
    const now = Date.now();

    // Initialize for all targets
    for (const hostname of targetHostnames) {
        activeOps[hostname] = { hack: [], grow: [], weaken: [] };
    }

    // Scan all servers for running workers
    const allServers = getAllServers(ns);
    for (const serverHost of allServers) {
        const runningScripts = ns.ps(serverHost);

        for (const script of runningScripts) {
            const target = script.args[0]; // Worker's first arg is target

            if (!activeOps[target]) continue; // Not one of our tracked targets

            // Get operation info and calculate remaining time
            const opInfo = sharedState.operationStartTimes[script.pid];
            let timeRemaining = 0;

            if (opInfo) {
                const elapsed = now - opInfo.startTime;
                let duration = 0;

                if (script.filename === "/hack-v1/workers/hack.js") {
                    duration = ns.getHackTime(target);
                } else if (script.filename === "/hack-v1/workers/grow.js") {
                    duration = ns.getGrowTime(target);
                } else if (script.filename === "/hack-v1/workers/weaken.js") {
                    duration = ns.getWeakenTime(target);
                }

                timeRemaining = Math.max(0, duration - elapsed);
            }

            const opData = {
                host: serverHost,
                threads: script.threads,
                timeRemaining: timeRemaining,
                pid: script.pid
            };

            if (script.filename === "/hack-v1/workers/hack.js") {
                activeOps[target].hack.push(opData);
            } else if (script.filename === "/hack-v1/workers/grow.js") {
                activeOps[target].grow.push(opData);
            } else if (script.filename === "/hack-v1/workers/weaken.js") {
                activeOps[target].weaken.push(opData);
            }
        }
    }

    // Clean up finished operations from tracking
    const allRunningPids = new Set();
    for (const serverHost of allServers) {
        const runningScripts = ns.ps(serverHost);
        for (const script of runningScripts) {
            allRunningPids.add(script.pid);
        }
    }

    for (const pid in sharedState.operationStartTimes) {
        if (!allRunningPids.has(parseInt(pid))) {
            delete sharedState.operationStartTimes[pid];
        }
    }

    return activeOps;
}
