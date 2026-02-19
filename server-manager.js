/** @param {NS} ns */

/**
 * Scan all servers in the network using BFS
 * @param {NS} ns
 * @returns {string[]} Array of all server hostnames
 */
export function scanAllServers(ns) {
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
 * Attempt to gain root access on a server
 * @param {NS} ns
 * @param {string} hostname
 * @returns {boolean} True if root access obtained
 */
export function rootServer(ns, hostname) {
    // Already have root
    if (ns.hasRootAccess(hostname)) {
        return true;
    }

    const portsRequired = ns.getServerNumPortsRequired(hostname);
    let portsOpened = 0;

    // Try all available port crackers
    if (ns.fileExists("BruteSSH.exe", "home")) {
        ns.brutessh(hostname);
        portsOpened++;
    }

    if (ns.fileExists("FTPCrack.exe", "home")) {
        ns.ftpcrack(hostname);
        portsOpened++;
    }

    if (ns.fileExists("relaySMTP.exe", "home")) {
        ns.relaysmtp(hostname);
        portsOpened++;
    }

    if (ns.fileExists("HTTPWorm.exe", "home")) {
        ns.httpworm(hostname);
        portsOpened++;
    }

    if (ns.fileExists("SQLInject.exe", "home")) {
        ns.sqlinject(hostname);
        portsOpened++;
    }

    // Try to nuke if enough ports opened
    if (portsOpened >= portsRequired) {
        ns.nuke(hostname);
        return ns.hasRootAccess(hostname);
    }

    return false;
}

/**
 * Check if we should purchase a new server
 * @param {NS} ns
 * @returns {{purchase: boolean, ram: number, name: string}} Purchase decision
 */
export function shouldPurchaseServer(ns) {
    const currentMoney = ns.getServerMoneyAvailable("home");

    // Don't spend more than 25% of current money on servers
    const budget = currentMoney * 0.25;

    // Check if we have room for more servers
    const owned = ns.getPurchasedServers();
    const limit = ns.getPurchasedServerLimit();

    if (owned.length >= limit) {
        return { purchase: false, ram: 0, name: "" };
    }

    // Find largest affordable RAM (powers of 2)
    let ram = 8;
    while (ram <= ns.getPurchasedServerMaxRam()) {
        const cost = ns.getPurchasedServerCost(ram * 2);
        if (cost > budget) {
            break;
        }
        ram *= 2;
    }

    // Check if we can afford at least 8GB
    const cost = ns.getPurchasedServerCost(ram);
    if (ram >= 8 && cost <= budget) {
        return {
            purchase: true,
            ram: ram,
            name: `worker-${owned.length}`
        };
    }

    return { purchase: false, ram: 0, name: "" };
}

/**
 * Purchase a server and set it up
 * @param {NS} ns
 * @param {number} ram
 * @param {string} name
 * @returns {string|null} Hostname of purchased server or null on failure
 */
export function purchaseAndSetup(ns, ram, name) {
    const hostname = ns.purchaseServer(name, ram);

    if (hostname) {
        ns.tprint(`Purchased server ${hostname} with ${ram}GB RAM`);
        return hostname;
    }

    return null;
}
