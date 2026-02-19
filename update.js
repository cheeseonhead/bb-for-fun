/** @param {NS} ns */
export async function main(ns) {
    const downloadUrl = "https://raw.githubusercontent.com/cheeseonhead/bb-for-fun/main/download.js";

    ns.tprint("=== HWGW System Updater ===");
    ns.tprint("Fetching latest downloader...");

    // Download the latest download.js
    const success = await ns.wget(downloadUrl, "download.js");

    if (!success) {
        ns.tprint("✗ Failed to download latest download.js");
        ns.tprint("Check your internet connection and try again.");
        return;
    }

    ns.tprint("✓ Downloaded latest download.js");
    ns.tprint("");
    ns.tprint("Running download.js...");
    ns.tprint("");

    // Run download.js
    ns.spawn("download.js", 1);
}
