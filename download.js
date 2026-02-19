/** @param {NS} ns */
export async function main(ns) {
    const baseUrl = "https://raw.githubusercontent.com/cheeseonhead/bb-for-fun/main/hack-v1";

    const files = [
        "launcher.js",
        "manager.js",
        "scheduler.js",
        "analyzer.js",
        "server-manager.js",
        "deploy.js",
        "workers/hack.js",
        "workers/grow.js",
        "workers/weaken.js"
    ];

    ns.tprint("=== HWGW System Downloader ===");
    ns.tprint("");

    // Delete existing hack-v1 folder
    ns.tprint("Cleaning up old installation...");
    const allFiles = [
        "hack-v1/launcher.js",
        "hack-v1/manager.js",
        "hack-v1/scheduler.js",
        "hack-v1/analyzer.js",
        "hack-v1/server-manager.js",
        "hack-v1/deploy.js",
        "hack-v1/workers/hack.js",
        "hack-v1/workers/grow.js",
        "hack-v1/workers/weaken.js"
    ];

    for (const file of allFiles) {
        if (ns.fileExists(file)) {
            ns.rm(file);
        }
    }

    ns.tprint("Starting download from GitHub...");
    ns.tprint("");

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
        const url = `${baseUrl}/${file}`;
        const localPath = `hack-v1/${file}`;
        const success = await ns.wget(url, localPath);

        if (success) {
            ns.tprint(`✓ Downloaded: ${localPath}`);
            successCount++;
        } else {
            ns.tprint(`✗ Failed: ${localPath}`);
            failCount++;
        }
    }

    ns.tprint("");
    ns.tprint(`Download complete! ${successCount} succeeded, ${failCount} failed.`);

    if (failCount === 0) {
        ns.tprint("");
        ns.tprint("To start the system, run: run hack-v1/launcher.js");
    } else {
        ns.tprint("");
        ns.tprint("Some files failed to download. Check your connection and try again.");
    }
}
