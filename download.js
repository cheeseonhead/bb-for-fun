/** @param {NS} ns */
export async function main(ns) {
    const baseUrl = "https://raw.githubusercontent.com/cheeseonhead/bb-for-fun/main";

    const files = [
        "analyzer.js",
        "deploy.js",
        "orchestrator.js",
        "server-manager.js",
        "workers/hack.js",
        "workers/grow.js",
        "workers/weaken.js"
    ];

    ns.tprint("Starting download from GitHub...");

    for (const file of files) {
        const url = `${baseUrl}/${file}`;
        const success = await ns.wget(url, file);

        if (success) {
            ns.tprint(`✓ Downloaded: ${file}`);
        } else {
            ns.tprint(`✗ Failed: ${file}`);
        }
    }

    ns.tprint("");
    ns.tprint("Download complete! Run: run orchestrator.js");
}
