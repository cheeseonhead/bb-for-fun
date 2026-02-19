/** @param {NS} ns */

// NO IMPORTS - Keep this script lightweight!

const PORT_STATUS = 2;
const LOOP_DELAY = 5000; // 5 seconds

/**
 * Deploy a script to a target server
 * @param {NS} ns
 * @param {string} scriptPath
 * @param {string} targetHost
 * @returns {Promise<boolean>} Success
 */
async function deployScript(ns, scriptPath, targetHost) {
    if (targetHost === "home") {
        return true; // Already there
    }

    try {
        await ns.scp(scriptPath, targetHost, "home");
        return ns.fileExists(scriptPath, targetHost);
    } catch (error) {
        ns.print(`Failed to deploy ${scriptPath} to ${targetHost}: ${error}`);
        return false;
    }
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.clearLog();
    ns.ui.openTail();

    ns.tprint("=== HWGW System Launcher ===");
    ns.tprint("Checking system state...");

    // Check script files exist
    const requiredFiles = [
        "/hack-v1/manager.js",
        "/hack-v1/scheduler.js",
        "/hack-v1/workers/hack.js",
        "/hack-v1/workers/grow.js",
        "/hack-v1/workers/weaken.js"
    ];

    let missingFiles = [];
    for (const file of requiredFiles) {
        if (!ns.fileExists(file)) {
            missingFiles.push(file);
        }
    }

    if (missingFiles.length > 0) {
        ns.tprint("ERROR: Missing required files:");
        for (const file of missingFiles) {
            ns.tprint(`  - ${file}`);
        }
        ns.tprint("Run download.js to install the system.");
        return;
    }

    // Show script RAM costs
    ns.tprint("Script RAM costs:");
    ns.tprint(`  manager.js: ${ns.getScriptRam("/hack-v1/manager.js")}GB`);
    ns.tprint(`  scheduler.js: ${ns.getScriptRam("/hack-v1/scheduler.js")}GB`);
    ns.tprint(`  launcher.js: ${ns.getScriptRam("/hack-v1/launcher.js")}GB`);
    ns.tprint("");

    // Show available servers
    const servers = getAllServersSimple(ns);
    const rooted = servers.filter(s => ns.hasRootAccess(s));
    ns.tprint(`Network: ${servers.length} servers found, ${rooted.length} rooted`);
    ns.tprint("Starting system...");
    ns.tprint("");

    let managerPid = 0;
    let schedulerPid = 0;
    let managerHost = "home";
    let schedulerHost = "home";
    let initMessageShown = false;

    while (true) {
        try {
            // 1. Check if manager is running, start if not
            if (!ns.isRunning(managerPid)) {
                ns.print("--- Starting Manager ---");
                const result = findServerForScript(ns, "/hack-v1/manager.js");

                if (!result) {
                    ns.print("Cannot start manager - see errors above");
                    ns.print("");
                } else {
                    managerHost = result.hostname;

                    // Deploy manager.js to target server first
                    ns.print(`Deploying manager.js to ${managerHost}...`);
                    const deployed = await deployScript(ns, "/hack-v1/manager.js", managerHost);

                    if (!deployed) {
                        ns.print(`✗ Failed to deploy to ${managerHost}`);
                        ns.print("");
                    } else {
                        // Now try to run it
                        managerPid = ns.exec("/hack-v1/manager.js", managerHost, 1);

                        if (managerPid > 0) {
                            ns.print(`✓ Manager started on ${managerHost} (PID: ${managerPid})`);
                        } else {
                            ns.print(`✗ exec() still returned 0 for ${managerHost}`);
                            ns.print(`  Script deployed but failed to run`);
                            ns.print(`  RAM needed: ${result.scriptRam}GB`);
                            ns.print(`  RAM free: ${result.freeRam}GB`);
                            ns.print(`  Check RAM availability and permissions`);
                        }
                        ns.print("");
                    }
                }
            }

            // 2. Check if scheduler is running, start if not
            if (!ns.isRunning(schedulerPid)) {
                ns.print("--- Starting Scheduler ---");
                const result = findServerForScript(ns, "/hack-v1/scheduler.js");

                if (!result) {
                    ns.print("Cannot start scheduler - see errors above");
                    ns.print("");
                } else {
                    schedulerHost = result.hostname;

                    // Deploy scheduler.js to target server first
                    ns.print(`Deploying scheduler.js to ${schedulerHost}...`);
                    const deployed = await deployScript(ns, "/hack-v1/scheduler.js", schedulerHost);

                    if (!deployed) {
                        ns.print(`✗ Failed to deploy to ${schedulerHost}`);
                        ns.print("");
                    } else {
                        // Now try to run it
                        schedulerPid = ns.exec("/hack-v1/scheduler.js", schedulerHost, 1);

                        if (schedulerPid > 0) {
                            ns.print(`✓ Scheduler started on ${schedulerHost} (PID: ${schedulerPid})`);
                        } else {
                            ns.print(`✗ exec() still returned 0 for ${schedulerHost}`);
                            ns.print(`  Script deployed but failed to run`);
                            ns.print(`  RAM needed: ${result.scriptRam}GB`);
                            ns.print(`  RAM free: ${result.freeRam}GB`);
                            ns.print(`  Check RAM availability and permissions`);
                        }
                        ns.print("");
                    }
                }
            }

            // 3. Read status from scheduler and display
            const statusData = ns.peek(PORT_STATUS);
            if (statusData !== "NULL PORT DATA") {
                displayStatus(ns, statusData);
                initMessageShown = false;
            } else {
                if (!initMessageShown) {
                    ns.print("Waiting for system initialization...");
                    initMessageShown = true;
                }
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
 * Get script RAM cost
 * @param {NS} ns
 * @param {string} scriptPath
 * @returns {number} RAM cost or -1 if script doesn't exist
 */
function getScriptRam(ns, scriptPath) {
    try {
        return ns.getScriptRam(scriptPath);
    } catch (error) {
        return -1;
    }
}

/**
 * Find a server with enough RAM to run a script
 * @param {NS} ns
 * @param {string} scriptPath
 * @returns {{hostname: string, scriptRam: number, freeRam: number}|null}
 */
function findServerForScript(ns, scriptPath) {
    const scriptRam = getScriptRam(ns, scriptPath);

    if (scriptRam === -1) {
        ns.print(`ERROR: Script not found: ${scriptPath}`);
        return null;
    }

    ns.print(`Looking for server with ${scriptRam.toFixed(2)}GB for ${scriptPath}`);

    const servers = getAllServersSimple(ns);
    const candidates = [];

    // First pass: collect all server info
    for (const hostname of servers) {
        const hasRoot = ns.hasRootAccess(hostname);
        const maxRam = ns.getServerMaxRam(hostname);
        const usedRam = ns.getServerUsedRam(hostname);
        const freeRam = maxRam - usedRam;

        candidates.push({ hostname, hasRoot, maxRam, usedRam, freeRam });
    }

    // Second pass: try to find suitable non-home server
    for (const s of candidates) {
        if (!s.hasRoot) continue;
        if (s.hostname === "home") continue;
        if (s.freeRam >= scriptRam) {
            ns.print(`  ✓ Selected: ${s.hostname} (${s.freeRam.toFixed(1)}GB free)`);
            return { hostname: s.hostname, scriptRam, freeRam: s.freeRam };
        }
    }

    // Show why each server was rejected
    const nonHomeServers = candidates.filter(s => s.hostname !== "home");
    if (nonHomeServers.length > 0) {
        ns.print(`  No suitable non-home server found. Candidates:`);
        for (const s of nonHomeServers.slice(0, 5)) { // Show top 5
            const reason = !s.hasRoot ? "no root" : `only ${s.freeRam.toFixed(1)}GB free`;
            ns.print(`    ${s.hostname}: ${reason}`);
        }
        if (nonHomeServers.length > 5) {
            ns.print(`    ... and ${nonHomeServers.length - 5} more`);
        }
    }

    // Fallback to home
    const homeServer = candidates.find(s => s.hostname === "home");
    if (homeServer && homeServer.freeRam >= scriptRam) {
        ns.print(`  ⚠ Using home (${homeServer.freeRam.toFixed(1)}GB free)`);
        return { hostname: "home", scriptRam, freeRam: homeServer.freeRam };
    }

    ns.print(`  ✗ No server has enough RAM (need ${scriptRam.toFixed(2)}GB)`);
    if (homeServer) {
        ns.print(`    home has only ${homeServer.freeRam.toFixed(1)}GB free`);
    }
    return null;
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
