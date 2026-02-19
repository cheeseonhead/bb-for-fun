/** @param {NS} ns */
export async function main(ns) {
    const baseUrl = "https://raw.githubusercontent.com/cheeseonhead/bb-for-fun/main";

    const files = [
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

    ns.tprint("=== HWGW System Downloader ===");
    ns.tprint("");

    // Clean up old installation using ls()
    ns.tprint("Cleaning up old installation...");
    const oldFiles = ns.ls("home", "hack-v1/");
    for (const file of oldFiles) {
        ns.rm(file);
    }
    if (oldFiles.length > 0) {
        ns.tprint(`Removed ${oldFiles.length} old files`);
    }
    ns.tprint("");

    // Download files
    ns.tprint("Starting download from GitHub...");
    ns.tprint("");

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
        const url = `${baseUrl}/${file}`;
        const success = await ns.wget(url, file);

        if (success) {
            ns.tprint(`✓ Downloaded: ${file}`);
            successCount++;
        } else {
            ns.tprint(`✗ Failed: ${file}`);
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
