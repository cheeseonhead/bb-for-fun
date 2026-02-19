/** @param {NS} ns */
export async function main(ns) {
    const PORT_CONTROL = 3;

    ns.tprint("=== HWGW System Shutdown ===");
    ns.tprint("Sending shutdown signal to launcher...");

    await ns.writePort(PORT_CONTROL, "SHUTDOWN");

    ns.tprint("✓ Shutdown signal sent");
    ns.tprint("Launcher will kill all system processes and exit");
}
