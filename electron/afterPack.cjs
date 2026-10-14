/**
 * The app is not signed with a Developer ID: ad-hoc sign the whole bundle
 * so Apple Silicon runs it (and the signature matches the edited Info.plist).
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
    if (ctx.electronPlatformName !== 'darwin') return;
    const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
