#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

// Get all tracked files
const files = execSync('git ls-files')
    .toString()
    .split('\n')
    .filter(f => f.match(/\.(js|ts|json)$/))
    .filter(f => !f.match(/^(\.git|node_modules|update\.js|download\.js|scripts\/)/))
    .filter(f => f.length > 0);

// Get unique folders
const folders = [...new Set(files.map(f => {
    const parts = f.split('/');
    parts.pop(); // Remove filename
    return parts.join('/');
}).filter(f => f.length > 0))];

// Generate download.js content
const downloadJs = `/** @param {NS} ns */
export async function main(ns) {
    const baseUrl = "https://raw.githubusercontent.com/cheeseonhead/bb-for-fun/main";

    const files = [
${files.map(f => `        "${f}"`).join(',\n')}
    ];

    ns.tprint("=== HWGW System Downloader ===");
    ns.tprint("");

    // Clean up old installation
    ns.tprint("Cleaning up old files...");
${folders.map(folder => {
    const varName = folder.replace(/[\/\-]/g, '_');
    return `    const ${varName}Files = ns.ls("home", "${folder}/");
    for (const file of ${varName}Files) {
        ns.rm(file);
    }`;
}).join('\n')}
    ns.tprint(\`Removed old files from tracked folders\`);
    ns.tprint("");

    // Download files
    ns.tprint("Starting download from GitHub...");
    ns.tprint("");

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
        const url = \`\${baseUrl}/\${file}\`;
        const success = await ns.wget(url, file);

        if (success) {
            ns.tprint(\`✓ Downloaded: \${file}\`);
            successCount++;
        } else {
            ns.tprint(\`✗ Failed: \${file}\`);
            failCount++;
        }
    }

    ns.tprint("");
    ns.tprint(\`Download complete! \${successCount} succeeded, \${failCount} failed.\`);

    if (failCount === 0) {
        ns.tprint("");
        ns.tprint("System downloaded successfully!");
        ns.tprint("Run: run hack-v1/launcher.js");
    } else {
        ns.tprint("");
        ns.tprint("Some files failed to download. Check your connection and try again.");
    }
}
`;

// Write download.js
fs.writeFileSync('download.js', downloadJs);

// Stage the file
execSync('git add download.js');

console.log('Pre-commit: Updated download.js with current file list');
