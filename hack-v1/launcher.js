/** @param {NS} ns */

// NO IMPORTS - Keep this script lightweight!

const PORT_STATUS = 2;
const LOOP_DELAY = 5000; // 5 seconds
const MANAGER_RAM = 10; // Estimated RAM for manager.js
const SCHEDULER_RAM = 10; // Estimated RAM for scheduler.js

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.clearLog();
    ns.tail();

    ns.tprint("=== HWGW System Launcher ===");
    ns.tprint("Starting distributed hacking system...");

    let managerPid = 0;
    let schedulerPid = 0;
    let managerHost = "home";
    let schedulerHost = "home";

    while (true) {
        try {
            // 1. Check if manager is running, start if not
            if (!ns.isRunning(managerPid)) {
                managerHost = findServerForScript(ns, MANAGER_RAM);
                managerPid = ns.exec("/hack-v1/manager.js", managerHost, 1);
                if (managerPid > 0) {
                    ns.print(`Started manager on ${managerHost} (PID: ${managerPid})`);
                } else {
                    ns.print(`Failed to start manager on ${managerHost}`);
                }
            }

            // 2. Check if scheduler is running, start if not
            if (!ns.isRunning(schedulerPid)) {
                schedulerHost = findServerForScript(ns, SCHEDULER_RAM);
                schedulerPid = ns.exec("/hack-v1/scheduler.js", schedulerHost, 1);
                if (schedulerPid > 0) {
                    ns.print(`Started scheduler on ${schedulerHost} (PID: ${schedulerPid})`);
                } else {
                    ns.print(`Failed to start scheduler on ${schedulerHost}`);
                }
            }

            // 3. Read status from scheduler and display
            const statusData = ns.peek(PORT_STATUS);
            if (statusData !== "NULL PORT DATA") {
                displayStatus(ns, statusData);
            } else {
                ns.print("Waiting for system initialization...");
            }

            // 4. Sleep until next cycle
            await ns.sleep(LOOP_DELAY);

        } catch (error) {
            ns.print(`ERROR: ${error}`);
            await ns.sleep(LOOP_DELAY);
        }
    }
}

/**
 * Find a server with enough RAM to run a script
 * @param {NS} ns
 * @param {number} scriptRam
 * @returns {string} hostname
 */
function findServerForScript(ns, scriptRam) {
    const servers = getAllServersSimple(ns);

    // Try non-home servers first
    for (const hostname of servers) {
        if (!ns.hasRootAccess(hostname)) continue;
        if (hostname === "home") continue;

        const freeRam = ns.getServerMaxRam(hostname) - ns.getServerUsedRam(hostname);
        if (freeRam >= scriptRam) {
            return hostname;
        }
    }

    // Fallback to home
    return "home";
}

/**
 * Get all servers using BFS scan (no imports)
 * @param {NS} ns
 * @returns {string[]}
 */
function getAllServersSimple(ns) {
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
 * Display system status
 * @param {NS} ns
 * @param {string} statusData
 */
function displayStatus(ns, statusData) {
    try {
        const status = JSON.parse(statusData);

        ns.clearLog();
        ns.print("=== HWGW System Status ===");
        ns.print("");

        // RAM info
        const totalRam = status.ramPool.reduce((sum, s) => sum + s.maxRam, 0);
        const usedRam = status.ramPool.reduce((sum, s) => sum + s.usedRam, 0);
        const freeRam = status.ramPool.reduce((sum, s) => sum + s.freeRam, 0);
        const utilization = totalRam > 0 ? (usedRam / totalRam * 100).toFixed(1) : 0;

        ns.print(`RAM: ${usedRam.toFixed(1)}/${totalRam.toFixed(1)} GB (${utilization}% util)`);
        ns.print(`Servers in pool: ${status.ramPool.length}`);
        ns.print(`Operations scheduled: ${status.opsScheduled}`);
        ns.print("");

        // Targets
        ns.print("Active Targets:");
        for (let i = 0; i < status.targets.length; i++) {
            const target = status.targets[i];
            const prepStatus = target.prepped ? "PREPPED" : "PREPPING";
            const moneyPct = target.maxMoney > 0 ? (target.money / target.maxMoney * 100).toFixed(0) : 0;

            ns.print(`${i + 1}. ${target.hostname} [${prepStatus}] $${ns.formatNumber(target.money)} (${moneyPct}%)`);
        }

        ns.print("");
        ns.print(`Player Money: $${ns.formatNumber(ns.getServerMoneyAvailable("home"))}`);

    } catch (error) {
        ns.print(`Error parsing status: ${error}`);
    }
}
