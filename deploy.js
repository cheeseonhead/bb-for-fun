/** @param {NS} ns */

/**
 * Deploy worker scripts to all servers
 * @param {NS} ns
 * @param {string[]} servers - Array of server hostnames to deploy to
 * @returns {Promise<boolean>}
 */
export async function deployWorkers(ns, servers) {
    const workers = [
        "/workers/hack.js",
        "/workers/grow.js",
        "/workers/weaken.js"
    ];

    let deployedCount = 0;

    for (const server of servers) {
        // Skip home server
        if (server === "home") {
            continue;
        }

        // Check if we have root access
        if (!ns.hasRootAccess(server)) {
            continue;
        }

        // Copy all worker scripts
        for (const worker of workers) {
            await ns.scp(worker, server, "home");
        }

        deployedCount++;
    }

    if (deployedCount > 0) {
        ns.print(`Deployed workers to ${deployedCount} servers`);
    }

    return true;
}
