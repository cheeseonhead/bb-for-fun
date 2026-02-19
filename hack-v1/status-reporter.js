/** @param {NS} ns */

import { isPrepped } from "/hack-v1/analyzer.js";

const PORT_SCHEDULER_STATE = 4; // Input port from scheduler
const PORT_STATUS = 2; // Output port for launcher
const WORKER_RAM = 1.75;

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("Status reporter started");

    const STATUS_DELAY = 1000; // 1 second
    let iteration = 0;

    while (true) {
        try {
            iteration++;

            // Read shared state from scheduler
            const stateData = ns.peek(PORT_SCHEDULER_STATE);
            if (stateData === "NULL PORT DATA") {
                if (iteration % 10 === 0) { // Only log every 10 seconds to reduce spam
                    ns.print(`[Status ${iteration}] Waiting for scheduler state...`);
                }
                await ns.sleep(STATUS_DELAY);
                continue;
            }

            const { servers, targets, operationStartTimes } = JSON.parse(stateData);

            if (!targets || targets.length === 0) {
                if (iteration % 10 === 0) {
                    ns.print(`[Status ${iteration}] No targets yet`);
                }
                await ns.sleep(STATUS_DELAY);
                continue;
            }

            // Build RAM pool
            const ramPool = buildRamPool(ns, servers);

            // Query actual running operations
            const targetHostnames = targets.map(t => t.hostname);
            const activeOperations = getActiveOperations(ns, targetHostnames, operationStartTimes || {});

            // Build status
            const status = {
                timestamp: Date.now(),
                ramPool: ramPool,
                targets: targets.slice(0, 5).map(t => {
                    const targetPrepped = isPrepped(ns, t.hostname);
                    const ops = activeOperations[t.hostname] || { hack: [], grow: [], weaken: [] };

                    return {
                        hostname: t.hostname,
                        score: t.score,
                        moneyPerSec: t.moneyPerSec,
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
                opsScheduled: targets.length
            };

            ns.clearPort(PORT_STATUS);
            await ns.writePort(PORT_STATUS, JSON.stringify(status));

            await ns.sleep(STATUS_DELAY);

        } catch (error) {
            ns.print(`[Status ${iteration}] ERROR: ${error}`);
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
        if (!ns.hasRootAccess(hostname)) {
            continue;
        }

        const maxRam = ns.getServerMaxRam(hostname);
        const usedRam = ns.getServerUsedRam(hostname);
        const freeRam = maxRam - usedRam;

        if (hostname === "home") {
            const reservedRam = 20;
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

    pool.sort((a, b) => b.freeRam - a.freeRam);

    return pool;
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
 * @param {Object} operationStartTimes
 * @returns {Object} Active operations by target
 */
function getActiveOperations(ns, targetHostnames, operationStartTimes) {
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
            const opInfo = operationStartTimes[script.pid];
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

    return activeOps;
}
