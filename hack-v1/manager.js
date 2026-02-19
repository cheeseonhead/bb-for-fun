/** @param {NS} ns */

import { scanAllServers, rootServer } from "/hack-v1/server-manager.js";
import { deployWorkers } from "/hack-v1/deploy.js";

const PORT_SERVER_LIST = 1; // Output port for server list
const LOOP_DELAY = 30000; // 30 seconds

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.print("Manager started");

    let knownServers = new Set();

    while (true) {
        try {
            // 1. Scan network for all servers
            const allServers = scanAllServers(ns);

            // 2. Root any new hackable servers
            let newlyRooted = [];
            for (const server of allServers) {
                if (!knownServers.has(server)) {
                    const rooted = rootServer(ns, server);
                    if (rooted && server !== "home") {
                        newlyRooted.push(server);
                        ns.print(`Rooted: ${server}`);
                    }
                    knownServers.add(server);
                }
            }

            // 3. Deploy workers to all rooted servers
            await deployWorkers(ns, allServers);

            // 4. Write server list to port for scheduler
            const serverData = {
                servers: allServers,
                timestamp: Date.now()
            };
            ns.clearPort(PORT_SERVER_LIST);
            await ns.writePort(PORT_SERVER_LIST, JSON.stringify(serverData));

            ns.print(`Managing ${allServers.length} servers, ${newlyRooted.length} newly rooted`);

            // 5. Sleep until next cycle
            await ns.sleep(LOOP_DELAY);

        } catch (error) {
            ns.print(`ERROR: ${error}`);
            await ns.sleep(LOOP_DELAY);
        }
    }
}
