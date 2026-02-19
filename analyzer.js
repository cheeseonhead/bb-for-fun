/** @param {NS} ns */

// Security constants
const WEAKEN_AMOUNT = 0.05;
const HACK_SECURITY_INCREASE = 0.002;
const GROW_SECURITY_INCREASE = 0.004;

/**
 * Check if a server is prepped (min security, max money)
 * @param {NS} ns
 * @param {string} target
 * @returns {boolean}
 */
export function isPrepped(ns, target) {
    const currentSec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const currentMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    // Allow small tolerance
    const secPrepped = currentSec <= minSec + 0.1;
    const moneyPrepped = currentMoney >= maxMoney * 0.99;

    return secPrepped && moneyPrepped;
}

/**
 * Calculate threads needed to prep a server
 * @param {NS} ns
 * @param {string} target
 * @returns {{weakenThreads: number, growThreads: number}}
 */
export function getPrepNeeds(ns, target) {
    const currentSec = ns.getServerSecurityLevel(target);
    const minSec = ns.getServerMinSecurityLevel(target);
    const currentMoney = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    // Calculate weaken threads needed
    const secToReduce = Math.max(0, currentSec - minSec);
    const weakenThreads = Math.ceil(secToReduce / WEAKEN_AMOUNT);

    // Calculate grow threads needed
    let growThreads = 0;
    if (currentMoney < maxMoney * 0.99) {
        // If money is 0 or very low, start with 1 to avoid division issues
        const baseMoney = Math.max(currentMoney, 1);
        const multiplier = maxMoney / baseMoney;
        growThreads = Math.ceil(ns.growthAnalyze(target, multiplier));
    }

    return { weakenThreads, growThreads };
}

/**
 * Calculate HWGW batch thread counts
 * @param {NS} ns
 * @param {string} target
 * @param {number} hackPercent - Percent of max money to hack (0-1)
 * @returns {{hackThreads: number, growThreads: number, weakenThreads: number}}
 */
export function calculateBatchSize(ns, target, hackPercent = 0.05) {
    const maxMoney = ns.getServerMaxMoney(target);
    const moneyToSteal = maxMoney * hackPercent;

    // Calculate hack threads
    const hackThreads = Math.max(1, Math.floor(ns.hackAnalyzeThreads(target, moneyToSteal)));

    // Calculate grow threads to restore money
    const growMultiplier = 1 / (1 - hackPercent);
    const growThreads = Math.ceil(ns.growthAnalyze(target, growMultiplier));

    // Calculate weaken threads to counter security increases
    const hackSecIncrease = hackThreads * HACK_SECURITY_INCREASE;
    const growSecIncrease = growThreads * GROW_SECURITY_INCREASE;
    const totalSecIncrease = hackSecIncrease + growSecIncrease;
    const weakenThreads = Math.ceil(totalSecIncrease / WEAKEN_AMOUNT);

    return { hackThreads, growThreads, weakenThreads };
}

/**
 * Get the best targets to hack, sorted by score
 * @param {NS} ns
 * @param {number} count - Number of targets to return
 * @returns {Array<{hostname: string, score: number}>}
 */
export function getBestTargets(ns, count = 5) {
    const player = ns.getPlayer();
    const servers = getAllServers(ns);
    const scored = [];

    for (const hostname of servers) {
        // Skip special servers
        if (hostname === "home" || hostname.startsWith("worker-")) {
            continue;
        }

        const server = ns.getServer(hostname);

        // Check if we can hack this server
        if (server.requiredHackingSkill > player.skills.hacking) {
            continue;
        }

        // Skip servers with no money
        if (server.moneyMax === 0) {
            continue;
        }

        // Calculate score
        const score = calculateTargetScore(ns, hostname, server);
        scored.push({ hostname, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, count);
}

/**
 * Calculate score for a target server
 * @param {NS} ns
 * @param {string} hostname
 * @param {Server} server
 * @returns {number}
 */
function calculateTargetScore(ns, hostname, server) {
    const hackTime = ns.getHackTime(hostname);
    const weakenTime = ns.getWeakenTime(hostname);
    const growTime = ns.getGrowTime(hostname);

    // Calculate prep overhead
    const currentSec = server.hackDifficulty;
    const minSec = server.minDifficulty;
    const currentMoney = server.moneyAvailable;
    const maxMoney = server.moneyMax;

    // Estimate prep time (simplified)
    const secToReduce = Math.max(0, currentSec - minSec);
    const prepWeakenTime = (secToReduce / WEAKEN_AMOUNT) * weakenTime;

    let prepGrowTime = 0;
    if (currentMoney < maxMoney * 0.5) {
        // Rough estimate for grow time
        prepGrowTime = growTime * 10; // Assume ~10 grow cycles needed
    }

    const totalPrepTime = prepWeakenTime + prepGrowTime;

    // Calculate ongoing money per second
    const hackPercent = 0.05; // Conservative 5%
    const hackChance = ns.hackAnalyzeChance(hostname);
    const moneyPerHack = maxMoney * hackPercent * hackChance;

    // Cycle time is dominated by the longest operation
    const cycleTime = Math.max(hackTime, weakenTime, growTime);
    const moneyPerSecond = moneyPerHack / (cycleTime / 1000);

    // Adjust score for prep time (amortize over 1 hour)
    const adjustedScore = moneyPerSecond / (1 + totalPrepTime / 3600000);

    return adjustedScore;
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
