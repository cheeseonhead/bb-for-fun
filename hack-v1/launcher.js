/** @param {NS} ns */

// NO IMPORTS - Keep this script lightweight!

const PORT_STATUS = 2;
const PORT_CONTROL = 3; // Control port for shutdown signal
const LOOP_DELAY = 5000; // 5 seconds

/**
 * Deploy all system scripts to a target server
 * @param {NS} ns
 * @param {string} targetHost
 * @returns {Promise<boolean>} Success
 */
async function deployAllScripts(ns, targetHost) {
    if (targetHost === "home") {
        return true; // Already there
    }

    const scripts = [
        "/hack-v1/manager.js",
        "/hack-v1/scheduler.js",
        "/hack-v1/analyzer.js",
        "/hack-v1/server-manager.js",
        "/hack-v1/deploy.js"
    ];

    try {
        ns.print(`  Cleaning old files on ${targetHost}...`);
        // Delete old versions first
        for (const script of scripts) {
            ns.rm(script, targetHost);
        }

        ns.print(`  Deploying ${scripts.length} scripts...`);
        // Deploy all scripts
        for (const script of scripts) {
            await ns.scp(script, targetHost, "home");
            if (!ns.fileExists(script, targetHost)) {
                ns.print(`  ✗ Failed to deploy: ${script}`);
                return false;
            }
        }
        return true;
    } catch (error) {
        ns.print(`  Failed to deploy scripts: ${error}`);
        return false;
    }
}

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.clearLog();
    ns.ui.openTail();

    ns.tprint("=== HWGW System Launcher ===");
    ns.tprint("Cleaning up any existing processes...");

    // Clean up old processes before starting
    const allServers = getAllServersSimple(ns);
    const systemScripts = [
        "/hack-v1/manager.js",
        "/hack-v1/scheduler.js",
        "/hack-v1/workers/hack.js",
        "/hack-v1/workers/grow.js",
        "/hack-v1/workers/weaken.js"
    ];

    let killedCount = 0;
    for (const hostname of allServers) {
        if (!ns.hasRootAccess(hostname)) continue;

        for (const script of systemScripts) {
            const killed = ns.scriptKill(script, hostname);
            if (killed) {
                killedCount++;
            }
        }
    }

    if (killedCount > 0) {
        ns.tprint(`✓ Killed ${killedCount} old processes`);
    }
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
    const rooted = allServers.filter(s => ns.hasRootAccess(s));
    ns.tprint(`Network: ${allServers.length} servers found, ${rooted.length} rooted`);
    ns.tprint("Starting system...");
    ns.tprint("");

    let managerPid = 0;
    let schedulerPid = 0;
    let managerHost = "home";
    let schedulerHost = "home";
    let lastDeployedServer = "";
    let initMessageShown = false;

    while (true) {
        try {
            // 0. Check for shutdown signal
            const controlSignal = ns.peek(PORT_CONTROL);
            if (controlSignal === "SHUTDOWN") {
                ns.readPort(PORT_CONTROL); // Clear signal
                killAllSystemProcesses(ns, managerPid, schedulerPid);
                ns.tprint("System shutdown initiated");
                return; // Exit launcher
            }

            // 1. Check if manager is running, start if not
            if (!ns.isRunning(managerPid)) {
                ns.print("--- Starting Manager ---");
                const result = findServerForScript(ns, "/hack-v1/manager.js");

                if (!result) {
                    ns.print("Cannot start manager - see errors above");
                    ns.print("");
                } else {
                    managerHost = result.hostname;

                    // Deploy all system scripts to target server (if not already deployed)
                    if (managerHost !== lastDeployedServer) {
                        ns.print(`Deploying system scripts to ${managerHost}...`);
                        const deployed = await deployAllScripts(ns, managerHost);

                        if (!deployed) {
                            ns.print(`✗ Failed to deploy to ${managerHost}`);
                            ns.print("");
                        } else {
                            lastDeployedServer = managerHost;
                            ns.print(`✓ Scripts deployed to ${managerHost}`);

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
                    } else {
                        ns.print(`Using existing deployment on ${managerHost}`);

                        // Try to run it
                        managerPid = ns.exec("/hack-v1/manager.js", managerHost, 1);

                        if (managerPid > 0) {
                            ns.print(`✓ Manager started on ${managerHost} (PID: ${managerPid})`);
                        } else {
                            ns.print(`✗ exec() returned 0 for ${managerHost}`);
                            ns.print(`  RAM needed: ${result.scriptRam}GB`);
                            ns.print(`  RAM free: ${result.freeRam}GB`);
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

                    // Deploy all system scripts to target server (if not already deployed)
                    if (schedulerHost !== lastDeployedServer) {
                        ns.print(`Deploying system scripts to ${schedulerHost}...`);
                        const deployed = await deployAllScripts(ns, schedulerHost);

                        if (!deployed) {
                            ns.print(`✗ Failed to deploy to ${schedulerHost}`);
                            ns.print("");
                        } else {
                            lastDeployedServer = schedulerHost;
                            ns.print(`✓ Scripts deployed to ${schedulerHost}`);

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
                    } else {
                        ns.print(`Using existing deployment on ${schedulerHost}`);

                        // Try to run it
                        schedulerPid = ns.exec("/hack-v1/scheduler.js", schedulerHost, 1);

                        if (schedulerPid > 0) {
                            ns.print(`✓ Scheduler started on ${schedulerHost} (PID: ${schedulerPid})`);
                        } else {
                            ns.print(`✗ exec() returned 0 for ${schedulerHost}`);
                            ns.print(`  RAM needed: ${result.scriptRam}GB`);
                            ns.print(`  RAM free: ${result.freeRam}GB`);
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

        // Targets (already sorted by priority)
        ns.print("Active Targets (by priority):");
        for (let i = 0; i < status.targets.length; i++) {
            const t = status.targets[i];

            // Determine status
            let statusLabel;
            if (t.prepped) {
                statusLabel = "PREPPED";
            } else if (t.activelyWorked) {
                statusLabel = "PREPPING"; // Actually being prepped
            } else {
                statusLabel = "QUEUED"; // Needs prep but not actively worked
            }

            const moneyPct = t.maxMoney > 0 ? (t.money / t.maxMoney * 100).toFixed(0) : 0;
            const moneyPerSec = ns.formatNumber(t.moneyPerSec);

            // Security info
            const currentSec = ns.getServerSecurityLevel(t.hostname);
            const minSec = ns.getServerMinSecurityLevel(t.hostname);
            const secDiff = (currentSec - minSec).toFixed(1);

            // Main target line
            ns.print(`${i + 1}. ${t.hostname} [${statusLabel}] $${ns.formatNumber(t.money)} (${moneyPct}%) | Sec: ${currentSec.toFixed(1)}/${minSec} (+${secDiff}) | ${moneyPerSec}/s`);

            // Operation details (if any active)
            const ops = t.operations;
            if (ops && (ops.hack.threads > 0 || ops.grow.threads > 0 || ops.weaken.threads > 0)) {
                const parts = [];
                if (ops.hack.threads > 0) parts.push(`H:${ops.hack.threads}t`);
                if (ops.grow.threads > 0) parts.push(`G:${ops.grow.threads}t`);
                if (ops.weaken.threads > 0) parts.push(`W:${ops.weaken.threads}t`);
                ns.print(`   ${parts.join(" | ")}`);
            }
        }

        ns.print("");
        ns.print(`Player Money: $${ns.formatNumber(ns.getServerMoneyAvailable("home"))}`);

    } catch (error) {
        ns.print(`Error parsing status: ${error}`);
    }
}

/**
 * Kill all HWGW system processes across all servers
 * @param {NS} ns
 * @param {number} managerPid - Manager PID
 * @param {number} schedulerPid - Scheduler PID
 */
function killAllSystemProcesses(ns, managerPid, schedulerPid) {
    ns.print("=== Killing All System Processes ===");
    ns.print("");

    // Kill manager and scheduler
    if (managerPid > 0) {
        ns.kill(managerPid);
        ns.print(`✓ Killed manager (PID: ${managerPid})`);
    }
    if (schedulerPid > 0) {
        ns.kill(schedulerPid);
        ns.print(`✓ Killed scheduler (PID: ${schedulerPid})`);
    }

    // Kill all workers across all servers
    const servers = getAllServersSimple(ns);
    const workerScripts = [
        "/hack-v1/workers/hack.js",
        "/hack-v1/workers/grow.js",
        "/hack-v1/workers/weaken.js"
    ];

    let workersKilled = 0;
    for (const hostname of servers) {
        if (!ns.hasRootAccess(hostname)) continue;

        for (const script of workerScripts) {
            const killed = ns.scriptKill(script, hostname);
            if (killed) {
                workersKilled++;
            }
        }
    }

    ns.print(`✓ Killed ${workersKilled} worker processes`);
    ns.print("");
    ns.print("System shutdown complete");
}
